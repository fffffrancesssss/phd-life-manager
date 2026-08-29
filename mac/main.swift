// PhD Life Manager — native macOS shell.
//
// Runs the local Python server as a child process and shows the interface
// in a WKWebView, so the whole thing behaves like an ordinary Mac app:
// its own window and Dock icon, no browser, and the server stops when you
// quit. If a server is already listening (say you started it in Terminal),
// the app attaches to that one instead of starting a second.

import Cocoa
import WebKit

// Where the Python half of the app lives. build.sh writes the path of the
// checkout it built from into the bundle, so a clone works wherever it was
// cloned to without anyone editing this file. The environment variable is
// an override for running the shell outside the normal build.
let projectDirectory: String = {
    let env = ProcessInfo.processInfo.environment["PHD_PROJECT_DIR"] ?? ""
    if !env.isEmpty { return env }
    if let p = Bundle.main.object(forInfoDictionaryKey: "PHDProjectDirectory") as? String,
       !p.isEmpty { return p }
    return FileManager.default.currentDirectoryPath
}()
let serverPort = 8765
let serverURL = URL(string: "http://127.0.0.1:\(serverPort)")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?          // nil when we attached to an existing server
    var loadingLabel: NSTextField!
    private var hasLaunched = false

    // MARK: - Server lifecycle

    private func serverIsUp() -> Bool {
        var request = URLRequest(url: serverURL)
        request.timeoutInterval = 1.0
        request.httpMethod = "HEAD"
        let semaphore = DispatchSemaphore(value: 0)
        var reachable = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode > 0 { reachable = true }
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 2.0)
        return reachable
    }

    private func startServer() {
        let python = "\(projectDirectory)/.venv/bin/python3"
        guard FileManager.default.isExecutableFile(atPath: python) else {
            fatalErrorAlert("""
                Couldn't find the Python environment at:
                \(python)

                From the project folder, run:
                  python3 -m venv .venv
                  .venv/bin/pip install -r requirements.txt
                """)
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["server.py"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectDirectory)
        // Lets the server notice if this app dies without a clean quit.
        var env = ProcessInfo.processInfo.environment
        env["PHD_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = env
        do {
            try process.run()
            serverProcess = process
        } catch {
            fatalErrorAlert("Couldn't start the server:\n\(error.localizedDescription)")
        }
    }

    private func fatalErrorAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "PhD Life Manager couldn't start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if !self.serverIsUp() {
                DispatchQueue.main.sync { self.startServer() }
                // Give it a moment to bind the port before pointing the view at it.
                for _ in 0..<40 {
                    if self.serverIsUp() { break }
                    Thread.sleep(forTimeInterval: 0.25)
                }
            }
            DispatchQueue.main.async {
                self.loadingLabel.isHidden = true
                self.webView.load(URLRequest(url: serverURL))
                self.hasLaunched = true
            }
        }
    }

    /// Coming back to the app is exactly when the calendar is most likely
    /// to be stale — you may have just edited something in Apple Calendar.
    /// It is also a good moment to notice the server has gone away and put
    /// it back, rather than leaving a dead page on screen.
    func applicationDidBecomeActive(_ notification: Notification) {
        guard hasLaunched else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.serverIsUp() {
                DispatchQueue.main.async {
                    self.webView?.evaluateJavaScript(
                        "typeof refreshLiveData === 'function' && refreshLiveData({force:true})",
                        completionHandler: nil)
                }
                return
            }
            DispatchQueue.main.sync { self.startServer() }
            for _ in 0..<40 {
                if self.serverIsUp() { break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async { self.webView?.reload() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Only stop the server if this app was the one that started it.
        serverProcess?.terminate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - UI

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1380, height: 900)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "PhD Life Manager"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 900, height: 600)
        window.setFrameAutosaveName("MainWindow")     // remembers size and position
        window.center()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        // Without this, WKWebView answers every confirm() with "no" and drops
        // every alert() on the floor — so in the app (but not in a browser)
        // "Delete this event?" silently did nothing, and a form that refused
        // to save never said why. See the WKUIDelegate section below.
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")

        loadingLabel = NSTextField(labelWithString: "Starting…")
        loadingLabel.font = .systemFont(ofSize: 13)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.alignment = .center
        loadingLabel.frame = NSRect(x: 0, y: frame.midY - 10, width: frame.width, height: 20)
        loadingLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]

        let container = NSView(frame: frame)
        container.addSubview(webView)
        container.addSubview(loadingLabel)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Without a real menu the standard editing shortcuts don't reach the
    /// web view — and this app is mostly typing, so that matters.
    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About PhD Life Manager", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func reloadPage() { webView.reload() }
    @objc private func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2.0) }
    @objc private func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc private func zoomReset() { webView.pageZoom = 1.0 }

    // MARK: - JavaScript dialogs
    //
    // WKWebView has no built-in UI for alert/confirm/prompt: unhandled, they
    // resolve to nothing, false and nil. The page uses confirm() to guard
    // every destructive action, so without these the delete buttons were dead
    // in the app while working perfectly in a browser.

    /// App-modal rather than a sheet: these have to answer synchronously for
    /// the completion handler, and one window makes a sheet no clearer.
    private func runPanel(_ style: NSAlert.Style,
                          _ message: String,
                          buttons: [String],
                          accessory: NSView? = nil) -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = style
        buttons.forEach { alert.addButton(withTitle: $0) }
        alert.accessoryView = accessory
        return alert.runModal()
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        _ = runPanel(.informational, message, buttons: ["OK"])
        completionHandler()
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        // The page only ever confirms deletions, so the affirmative button is
        // the destructive one and Cancel is what Escape and Return-safety land on.
        let response = runPanel(.warning, message, buttons: ["Delete", "Cancel"])
        completionHandler(response == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        let response = runPanel(.informational, prompt, buttons: ["OK", "Cancel"], accessory: field)
        completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // Anything that isn't the local app opens in the real browser.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let host = url.host,
           host != "127.0.0.1" && host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
