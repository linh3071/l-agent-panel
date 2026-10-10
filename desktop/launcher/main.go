// agent-panel 便携版启动器（Windows）。
//
// 职责：
//   1. 拉起内置 node 运行 server/index.js（隐藏控制台窗口，日志写入 logs/server.log）
//   2. 用独立的 Edge 应用窗口打开面板（--app 模式，无地址栏，接近原生应用）
//   3. 窗口关闭后结束全部子进程，不在后台驻留
//
// 「不驻留」的兜底保证：面板页面每 5s 向 /api/ping 上报心跳，服务端在心跳停止
// AGENT_PANEL_IDLE_EXIT_SECONDS 秒后自行退出。因此即使启动器被强杀、或浏览器
// 异常退出、或窗口被移交给别的 Edge 实例，也不会有残留的服务进程。
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	idleExitSeconds  = 20                    // 与服务端约定的心跳超时
	edgeHandoffGrace = 3 * time.Second       // Edge 启动后此时长内退出视为「移交已有实例」
	serverReadyWait  = 25 * time.Second      // 等待服务就绪上限
)

var (
	exeDir  string
	logFile *os.File

	// 隐藏命令行子进程的控制台窗口（node / taskkill / rundll32）
	hiddenProc = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
)

func logLine(format string, args ...any) {
	line := fmt.Sprintf("[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
	if logFile != nil {
		logFile.WriteString(line)
	}
}

func messageBox(title, text string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	t, err1 := syscall.UTF16PtrFromString(text)
	c, err2 := syscall.UTF16PtrFromString(title)
	if err1 != nil || err2 != nil {
		return
	}
	proc.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), 0x10) // MB_ICONERROR
}

// ---------- 配置与路径 ----------

type panelConfig struct {
	Server struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	} `json:"server"`
}

func baseURL() string {
	host, port := "127.0.0.1", 8787
	if raw, err := os.ReadFile(filepath.Join(exeDir, "config.json")); err == nil {
		var c panelConfig
		if json.Unmarshal(raw, &c) == nil {
			if strings.TrimSpace(c.Server.Host) != "" {
				host = c.Server.Host
			}
			if c.Server.Port > 0 {
				port = c.Server.Port
			}
		}
	}
	return fmt.Sprintf("http://%s:%d/", host, port)
}

func ensureConfig() {
	cfg := filepath.Join(exeDir, "config.json")
	if _, err := os.Stat(cfg); err == nil {
		return
	}
	if raw, err := os.ReadFile(filepath.Join(exeDir, "config.example.json")); err == nil {
		if os.WriteFile(cfg, raw, 0o644) == nil {
			logLine("config.json 不存在，已从 config.example.json 创建，请填入各平台 apiKey")
		}
	}
}

func findFirst(paths ...string) string {
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func findEdge() string {
	return findFirst(
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "Edge", "Application", "msedge.exe"),
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
	)
}

// ---------- 进程工具 ----------

func serverReady(url string) bool {
	client := &http.Client{Timeout: 900 * time.Millisecond}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return true
}

func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	kill := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	kill.SysProcAttr = hiddenProc
	_ = kill.Run()
	_ = cmd.Process.Kill()
}

func exitCodeOf(cmd *exec.Cmd) string {
	if cmd == nil || cmd.ProcessState == nil {
		return "?"
	}
	return strconv.Itoa(cmd.ProcessState.ExitCode())
}

// ---------- 主流程 ----------

func main() {
	self, err := os.Executable()
	if err != nil {
		messageBox("Agent Panel", "无法定位启动器路径："+err.Error())
		return
	}
	exeDir = filepath.Dir(self)

	runtimeDir := filepath.Join(exeDir, "runtime")
	_ = os.MkdirAll(runtimeDir, 0o755)
	if lf, err := os.OpenFile(filepath.Join(runtimeDir, "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		logFile = lf
		defer lf.Close()
	}
	logLine("==== 启动器运行：%s ====", self)

	ensureConfig()
	url := baseURL()
	logLine("面板地址：%s", url)

	// 已有实例在运行：只开窗，不重复启动服务；窗口关闭后由心跳机制让它自行退出
	if serverReady(url) {
		logLine("检测到面板服务已在运行，直接打开窗口")
		window := openWindow(url)
		if window != nil {
			_ = window.Wait()
		}
		logLine("窗口已关闭，退出（已在运行的服务将在心跳超时后自行退出）")
		return
	}

	nodeExe := findFirst(filepath.Join(exeDir, "node", "node.exe"), filepath.Join(exeDir, "node.exe"))
	if nodeExe == "" {
		logLine("错误：未找到内置 node\\node.exe")
		messageBox("Agent Panel", "便携包不完整：未找到 node\\node.exe")
		return
	}

	_ = os.MkdirAll(filepath.Join(exeDir, "logs"), 0o755)
	serverLog, err := os.OpenFile(filepath.Join(exeDir, "logs", "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		serverLog = nil
	} else {
		defer serverLog.Close()
	}

	node := exec.Command(nodeExe, filepath.Join(exeDir, "server", "index.js"))
	node.Dir = exeDir
	node.SysProcAttr = hiddenProc
	node.Env = append(os.Environ(),
		"AGENT_PANEL_IDLE_EXIT_SECONDS="+strconv.Itoa(idleExitSeconds),
		"NODE_USE_ENV_PROXY=1", // 让 node 的 fetch 读取系统代理环境变量
	)
	if serverLog != nil {
		node.Stdout = serverLog
		node.Stderr = serverLog
	}
	if err := node.Start(); err != nil {
		logLine("启动 node 失败：%v", err)
		messageBox("Agent Panel", "启动服务失败："+err.Error())
		return
	}
	logLine("node 已启动，pid=%d", node.Process.Pid)

	nodeDone := make(chan struct{})
	go func() { _ = node.Wait(); close(nodeDone) }()

	deadline := time.Now().Add(serverReadyWait)
	for !serverReady(url) {
		select {
		case <-nodeDone:
			logLine("node 提前退出（exit=%s），请查看 logs\\server.log", exitCodeOf(node))
			messageBox("Agent Panel", "面板服务启动失败，请查看 logs\\server.log")
			return
		default:
		}
		if time.Now().After(deadline) {
			logLine("服务在 %v 内未就绪，终止", serverReadyWait)
			messageBox("Agent Panel", "面板服务启动超时，请查看 logs\\server.log")
			killTree(node)
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	logLine("服务已就绪")

	window := openWindow(url)
	if window == nil {
		// 无窗口可跟踪（Edge 缺失，用了默认浏览器）：等服务端心跳超时自行退出
		logLine("等待服务端心跳超时退出…")
		<-nodeDone
		logLine("服务端已退出")
		return
	}

	windowDone := make(chan struct{})
	windowStarted := time.Now()
	go func() { _ = window.Wait(); close(windowDone) }()

	select {
	case <-windowDone:
		if time.Since(windowStarted) < edgeHandoffGrace {
			// Edge 把窗口交给了已有实例后自身退出，不能据此判断窗口已关闭；
			// 改为等服务端心跳超时（窗口真关了才会超时）
			logLine("Edge 进程提前退出（疑似复用已有窗口），等待心跳超时…")
			<-nodeDone
			logLine("服务端已退出")
			return
		}
		logLine("窗口已关闭，结束服务进程")
		killTree(node)
	case <-nodeDone:
		logLine("服务端已退出（exit=%s），关闭窗口", exitCodeOf(node))
		killTree(window)
	}
	logLine("全部进程已结束，退出")
}

// openWindow 打开面板窗口：优先 Edge 应用模式（可感知关闭），否则退回默认浏览器
func openWindow(url string) *exec.Cmd {
	edgeExe := findEdge()
	if edgeExe == "" {
		logLine("未找到 Edge，使用默认浏览器打开（将依赖心跳超时退出）")
		fallback := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		fallback.SysProcAttr = hiddenProc
		_ = fallback.Run()
		return nil
	}
	cmd := exec.Command(edgeExe,
		"--app="+url,
		"--user-data-dir="+filepath.Join(exeDir, "runtime", "edge-profile"),
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1280,900",
	)
	if err := cmd.Start(); err != nil {
		logLine("启动 Edge 失败：%v，改用默认浏览器", err)
		fallback := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
		fallback.SysProcAttr = hiddenProc
		_ = fallback.Run()
		return nil
	}
	logLine("Edge 应用窗口已启动，pid=%d", cmd.Process.Pid)
	return cmd
}
