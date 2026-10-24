#import <Cocoa/Cocoa.h>
#include <crt_externs.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/cef_parser.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_devtools_message_observer.h"
#include "include/cef_display_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/cef_request_handler.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_library_loader.h"
#include "include/wrapper/cef_closure_task.h"

using MVCEFEventCallback = void (*)(void*, const char*, const char*);
using MVCEFResultCallback = void (*)(void*, int, const char*);

namespace {
std::unique_ptr<CefScopedLibraryLoader> g_loader;
CefRefPtr<CefApp> g_app;
std::atomic<bool> g_initialized{false};
std::atomic<int> g_browser_count{0};
class BrowserClient;
std::mutex g_clients_lock;
std::set<BrowserClient*> g_clients;

std::string JSONString(const std::string& value) {
  CefRefPtr<CefValue> root = CefValue::Create();
  root->SetString(value);
  return CefWriteJSON(root, JSON_WRITER_DEFAULT).ToString();
}

std::string StateJSON(const char* kind, const std::string& value = {}) {
  return std::string("{\"kind\":") + JSONString(kind) + ",\"value\":" + JSONString(value) + "}";
}

class BrowserApp : public CefApp, public CefBrowserProcessHandler {
 public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnBeforeCommandLineProcessing(const CefString&, CefRefPtr<CefCommandLine> command_line) override {
    const char* testing = getenv("MULTIVIBE_CHROMIUM_TESTING");
    if (testing && strcmp(testing, "1") == 0) { command_line->AppendSwitch("use-mock-keychain"); command_line->AppendSwitch("no-sandbox"); }
  }
  void OnScheduleMessagePumpWork(int64_t delay_ms) override {
    const int64_t bounded = std::max<int64_t>(0, std::min<int64_t>(delay_ms, 100));
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, bounded * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      if (g_initialized.load()) CefDoMessageLoopWork();
    });
  }
 private:
  IMPLEMENT_REFCOUNTING(BrowserApp);
};

class BrowserClient : public CefClient,
                      public CefLifeSpanHandler,
                      public CefLoadHandler,
                      public CefDisplayHandler,
                      public CefRequestHandler,
                      public CefDownloadHandler,
                      public CefDevToolsMessageObserver {
 public:
  BrowserClient(MVCEFEventCallback callback, void* context) : callback_(callback), context_(context) {}
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }

  void Emit(const char* event, const std::string& json) {
    if (callback_) callback_(context_, event, json.c_str());
  }
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    browser_ = browser;
    devtools_registration_ = browser->GetHost()->AddDevToolsMessageObserver(this);
    NSView* view = CAST_CEF_WINDOW_HANDLE_TO_NSVIEW(browser->GetHost()->GetWindowHandle());
    if (view) {
      view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      if (view.superview) view.frame = view.superview.bounds;
    }
    ++g_browser_count;
    { std::lock_guard<std::mutex> guard(g_clients_lock); g_clients.insert(this); }
    Emit("ready", "{}");
  }
  bool DoClose(CefRefPtr<CefBrowser> browser) override { return false; }
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    devtools_registration_ = nullptr;
    browser_ = nullptr;
    { std::lock_guard<std::mutex> guard(g_clients_lock); g_clients.erase(this); }
    --g_browser_count;
    Emit("closed", "{}");
  }
  bool OnBeforePopup(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, int,
                     const CefString& target_url, const CefString&,
                     WindowOpenDisposition, bool, const CefPopupFeatures&,
                     CefWindowInfo&, CefRefPtr<CefClient>&, CefBrowserSettings&,
                     CefRefPtr<CefDictionaryValue>&, bool*) override {
    Emit("blocked", StateJSON("popup", target_url.ToString()));
    return true;
  }
  void OnLoadingStateChange(CefRefPtr<CefBrowser>, bool loading, bool back, bool forward) override {
    Emit("loading", std::string("{\"loading\":") + (loading ? "true" : "false") +
      ",\"back\":" + (back ? "true" : "false") + ",\"forward\":" + (forward ? "true" : "false") + "}");
  }
  void OnAddressChange(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, const CefString& url) override {
    if (frame && frame->IsMain()) { Emit("url", StateJSON("url", url.ToString())); }
  }
  void OnTitleChange(CefRefPtr<CefBrowser>, const CefString& title) override {
    Emit("title", StateJSON("title", title.ToString()));
  }
  void OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, ErrorCode code,
                   const CefString& text, const CefString& failed_url) override {
    if (frame && frame->IsMain() && code != ERR_ABORTED)
      Emit("error", std::string("{\"code\":") + std::to_string(code) + ",\"message\":" + JSONString(text.ToString()) + ",\"url\":" + JSONString(failed_url.ToString()) + "}");
  }
  bool OnBeforeBrowse(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request, bool, bool) override {
    if (!frame || !frame->IsMain()) return false;
    const std::string url = request->GetURL().ToString();
    if (url == "about:blank") return false;
    CefURLParts parts;
    if (!CefParseURL(url, parts)) return true;
    const std::string scheme = CefString(&parts.scheme).ToString();
    const std::string host = CefString(&parts.host).ToString();
    std::string origin = scheme + "://" + host;
    const std::string port = CefString(&parts.port).ToString();
    if (!port.empty()) origin += ":" + port;
    std::lock_guard<std::mutex> guard(lock_);
    if (allowed_origins_.contains(origin)) return false;
    Emit("blocked", StateJSON("origin", origin));
    return true;
  }
  bool GetAuthCredentials(CefRefPtr<CefBrowser>, const CefString&, bool,
                          const CefString&, int, const CefString&, const CefString&,
                          CefRefPtr<CefAuthCallback>) override { return false; }
  bool OnCertificateError(CefRefPtr<CefBrowser>, ErrorCode, const CefString& request_url,
                          CefRefPtr<CefSSLInfo>, CefRefPtr<CefCallback>) override {
    Emit("blocked", StateJSON("certificate", request_url.ToString()));
    return false;
  }
  bool OnBeforeDownload(CefRefPtr<CefBrowser>, CefRefPtr<CefDownloadItem> item,
                        const CefString&, CefRefPtr<CefBeforeDownloadCallback>) override {
    Emit("blocked", StateJSON("download", item ? item->GetURL().ToString() : ""));
    return true;
  }
  void OnDevToolsMethodResult(CefRefPtr<CefBrowser>, int message_id, bool success,
                              const void* result, size_t result_size) override {
    Pending pending;
    {
      std::lock_guard<std::mutex> guard(lock_);
      auto it = pending_.find(message_id);
      if (it == pending_.end()) return;
      pending = it->second;
      pending_.erase(it);
    }
    std::string value;
    if (result && result_size) value.assign(static_cast<const char*>(result), result_size);
    if (pending.callback) pending.callback(pending.context, success ? 1 : 0, value.c_str());
  }
  void SetAllowedOrigins(const std::set<std::string>& origins) {
    std::lock_guard<std::mutex> guard(lock_); allowed_origins_ = origins;
  }
  bool Execute(const std::string& method, const std::string& params_json,
               MVCEFResultCallback callback, void* context) {
    CEF_REQUIRE_UI_THREAD();
    if (!browser_) return false;
    CefRefPtr<CefDictionaryValue> params;
    if (!params_json.empty()) {
      auto parsed = CefParseJSON(params_json, JSON_PARSER_RFC);
      if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) return false;
      params = parsed->GetDictionary();
    }
    int id = browser_->GetHost()->ExecuteDevToolsMethod(0, method, params);
    if (!id) return false;
    std::lock_guard<std::mutex> guard(lock_);
    pending_[id] = {callback, context};
    return true;
  }
  void Navigate(const std::string& url) { if (browser_) browser_->GetMainFrame()->LoadURL(url); }
  void Back() { if (browser_ && browser_->CanGoBack()) browser_->GoBack(); }
  void Forward() { if (browser_ && browser_->CanGoForward()) browser_->GoForward(); }
  void Reload(bool no_cache) { if (browser_) no_cache ? browser_->ReloadIgnoreCache() : browser_->Reload(); }
  void Stop() { if (browser_) browser_->StopLoad(); }
  void Focus(bool focus) { if (browser_) browser_->GetHost()->SetFocus(focus); }
  void Close() { if (browser_) browser_->GetHost()->CloseBrowser(true); }
  void Detach() {
    std::vector<Pending> callbacks;
    {
      std::lock_guard<std::mutex> guard(lock_);
      for (const auto& entry : pending_) callbacks.push_back(entry.second);
      pending_.clear(); callback_ = nullptr; context_ = nullptr;
    }
    for (const auto& pending : callbacks) {
      if (pending.callback) pending.callback(pending.context, 0, "Browser closed");
    }
  }
 private:
  struct Pending { MVCEFResultCallback callback = nullptr; void* context = nullptr; };
  MVCEFEventCallback callback_;
  void* context_;
  CefRefPtr<CefBrowser> browser_;
  CefRefPtr<CefRegistration> devtools_registration_;
  std::mutex lock_;
  std::set<std::string> allowed_origins_;
  std::map<int, Pending> pending_;
  IMPLEMENT_REFCOUNTING(BrowserClient);
};

struct BrowserHandle { CefRefPtr<BrowserClient> client; };
}  // namespace

@interface MVCEFApplication : NSApplication <CefAppProtocol> {
 @private BOOL handlingSendEvent_;
}
@end
@implementation MVCEFApplication
- (BOOL)isHandlingSendEvent { return handlingSendEvent_; }
- (void)setHandlingSendEvent:(BOOL)value { handlingSendEvent_ = value; }
- (void)sendEvent:(NSEvent*)event { CefScopedSendingEvent scope; [super sendEvent:event]; }
@end

extern "C" bool mvcef_initialize(const char* helper_path, const char* cache_path) {
  if (g_initialized.load()) return true;
  g_loader = std::make_unique<CefScopedLibraryLoader>();
  if (!g_loader->LoadInMain()) return false;
  CefMainArgs args(*_NSGetArgc(), *_NSGetArgv());
  CefSettings settings;
  settings.external_message_pump = true;
  settings.persist_session_cookies = true;
  const char* testing = getenv("MULTIVIBE_CHROMIUM_TESTING");
  if (testing && strcmp(testing, "1") == 0) {
    settings.no_sandbox = true;
    settings.log_severity = LOGSEVERITY_INFO;
    CefString(&settings.log_file) = std::string(cache_path) + "/cef.log";
  } else { settings.log_severity = LOGSEVERITY_DISABLE; }
  CefString(&settings.browser_subprocess_path) = helper_path;
  CefString(&settings.root_cache_path) = cache_path;
  CefString(&settings.cache_path) = std::string(cache_path) + "/Default";
  // Never share Chromium's generic Safe Storage item with another CEF app.
  // A dedicated identity keeps encrypted cookies persistent without triggering
  // macOS prompts for an unrelated app's Keychain ACL.
  CefString(&settings.keychain_service_name) = "MultiVibe Chromium Safe Storage";
  CefString(&settings.keychain_account_name) = "MultiVibe";
  CefString(&settings.locale) = "fr-FR";
  g_app = new BrowserApp();
  if (!CefInitialize(args, settings, g_app, nullptr)) { g_app = nullptr; g_loader.reset(); return false; }
  g_initialized.store(true);
  return true;
}
extern "C" bool mvcef_is_initialized() { return g_initialized.load(); }
extern "C" void mvcef_do_message_loop_work() { if (g_initialized.load()) CefDoMessageLoopWork(); }
extern "C" void mvcef_shutdown() {
  if (!g_initialized.load()) return;
  std::vector<BrowserClient*> clients;
  { std::lock_guard<std::mutex> guard(g_clients_lock); clients.assign(g_clients.begin(), g_clients.end()); }
  for (auto* client : clients) client->Close();
  const auto deadline = CFAbsoluteTimeGetCurrent() + 3.0;
  while (g_browser_count.load() > 0 && CFAbsoluteTimeGetCurrent() < deadline) {
    CefDoMessageLoopWork();
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  g_initialized.store(false);
  CefShutdown(); g_app = nullptr; g_loader.reset();
}
extern "C" void* mvcef_browser_create(void* parent_view, MVCEFEventCallback callback, void* context) {
  if (!g_initialized.load() || !parent_view) return nullptr;
  auto* handle = new BrowserHandle{new BrowserClient(callback, context)};
  NSView* view = (__bridge NSView*)parent_view;
  CefWindowInfo info;
  info.SetAsChild(parent_view, CefRect(0, 0, std::max(1, (int)view.bounds.size.width), std::max(1, (int)view.bounds.size.height)));
  CefBrowserSettings settings;
  settings.windowless_frame_rate = 60;
  const bool submitted = CefBrowserHost::CreateBrowser(info, handle->client, "about:blank", settings, nullptr, nullptr);
  if (!submitted) {
    delete handle; return nullptr;
  }
  return handle;
}
extern "C" void mvcef_browser_destroy(void* raw) {
  if (auto* h = static_cast<BrowserHandle*>(raw)) {
    h->client->Detach(); h->client->Close(); delete h;
  }
}
extern "C" void mvcef_browser_navigate(void* raw, const char* url) { if (auto* h = static_cast<BrowserHandle*>(raw)) h->client->Navigate(url ?: ""); }
extern "C" void mvcef_browser_back(void* raw) { if (auto* h = static_cast<BrowserHandle*>(raw)) h->client->Back(); }
extern "C" void mvcef_browser_forward(void* raw) { if (auto* h = static_cast<BrowserHandle*>(raw)) h->client->Forward(); }
extern "C" void mvcef_browser_reload(void* raw, bool no_cache) { if (auto* h = static_cast<BrowserHandle*>(raw)) h->client->Reload(no_cache); }
extern "C" void mvcef_browser_stop(void* raw) { if (auto* h = static_cast<BrowserHandle*>(raw)) h->client->Stop(); }
extern "C" void mvcef_browser_focus(void* raw, bool focus) { if (auto* h = static_cast<BrowserHandle*>(raw)) h->client->Focus(focus); }
extern "C" void mvcef_browser_set_allowed_origins(void* raw, const char* lines) {
  auto* h = static_cast<BrowserHandle*>(raw); if (!h) return;
  std::set<std::string> origins; std::string value = lines ?: ""; size_t start = 0;
  while (start <= value.size()) { size_t end = value.find('\n', start); std::string item = value.substr(start, end - start); if (!item.empty()) origins.insert(item); if (end == std::string::npos) break; start = end + 1; }
  h->client->SetAllowedOrigins(origins);
}
extern "C" bool mvcef_browser_execute(void* raw, const char* method, const char* params,
                                      MVCEFResultCallback callback, void* context) {
  auto* h = static_cast<BrowserHandle*>(raw); return h && h->client->Execute(method ?: "", params ?: "", callback, context);
}
