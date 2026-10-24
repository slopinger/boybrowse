// Copyright 2026 slop. MIT license; see repository LICENSE.
#include "chrome/browser/ui/webui/boybrowse/boybrowse_ui.h"

#include <string>
#include <utility>
#include "base/base64.h"
#include "base/json/json_writer.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "base/values.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/bookmarks/bookmark_model_factory.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "components/bookmarks/browser/bookmark_node.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/split_tab_metrics.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui/boybrowse/resources.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/async/common/encryptor.h"
#include "components/prefs/pref_service.h"
#include "components/split_tabs/split_tab_visual_data.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace {
constexpr char kState[] = "boybrowse.state";
constexpr char kSecrets[] = "boybrowse.secrets";
class Handler : public content::WebUIMessageHandler {
 public:
  Handler() = default;
  void RegisterMessages() override {
    web_ui()->RegisterMessageCallback("boybrowse",
        base::BindRepeating(&Handler::Handle, base::Unretained(this)));
  }
 private:
  Profile* profile() { return Profile::FromWebUI(web_ui()); }
  BrowserWindowInterface* browser() {
    for (auto* window : GetAllBrowserWindowInterfaces()) {
      if (window->GetProfile() != profile()) continue;
      auto* model = window->GetTabStripModel();
      if (model && model->GetIndexOfWebContents(web_ui()->GetWebContents()) != TabStripModel::kNoTab)
        return window;
    }
    return nullptr;
  }
  void Reply(const base::Value& callback, base::Value value) {
    ResolveJavascriptCallback(callback, value);
  }
  void Persist(const base::Value& callback, base::Value value) {
    profile()->GetPrefs()->CommitPendingWrite(base::BindOnce(&Handler::Reply,
        weak_.GetWeakPtr(), callback.Clone(), std::move(value)));
  }
  void Fail(const base::Value& callback, const char* error) {
    RejectJavascriptCallback(callback, base::Value(error));
  }
  void Secret(base::Value callback, std::string op, std::string value,
              scoped_refptr<os_crypt_async::Encryptor> encryptor) {
    if (!encryptor || !encryptor->IsEncryptionAvailable()) { Fail(callback, "OS credential protection unavailable"); return; }
    std::string result;
    if (op == "secret.save") {
      if (!encryptor->EncryptString(value, &result)) { Fail(callback, "Encryption failed"); return; }
      profile()->GetPrefs()->SetString(kSecrets, base::Base64Encode(result));
      Persist(callback, base::Value(true));
    } else {
      const std::string& stored = profile()->GetPrefs()->GetString(kSecrets);
      if (stored.empty()) { Reply(callback, base::Value("")); return; }
      std::string ciphertext;
      if (!base::Base64Decode(stored, &ciphertext) || !encryptor->DecryptString(ciphertext, &result)) {
        Fail(callback, "Cannot unlock this device"); return;
      }
      Reply(callback, base::Value(result));
    }
  }
  void Handle(const base::ListValue& args) {
    if (args.size() != 3 || !args[0].is_string() || !args[1].is_string() || !args[2].is_dict()) return;
    AllowJavascript();
    const auto& callback = args[0];
    const auto& op = args[1].GetString();
    const auto& data = args[2].GetDict();
    if (op == "state.read") {
      Reply(callback, base::Value(profile()->GetPrefs()->GetDict(kState).Clone())); return;
    }
    if (op == "state.save") {
      // Cap the serialized state on the renderer side and total value memory here.
      if (base::WriteJson(data).value_or("").size() > 2 * 1024 * 1024) { Fail(callback, "State too large"); return; }
      int generation = profile()->GetPrefs()->GetDict(kState).FindInt("_generation").value_or(0);
      if (data.FindInt("_generation").value_or(0) != generation) {
        Fail(callback, "Another Boybrowse page saved changes. Reload before editing to keep both windows safe."); return;
      }
      auto next = data.Clone(); next.Set("_generation", generation + 1);
      profile()->GetPrefs()->SetDict(kState, std::move(next));
      Persist(callback, base::Value(generation + 1)); return;
    }
    if (op == "secret.read" || op == "secret.save") {
      const auto* value = data.FindString("value");
      if (op == "secret.save" && (!value || value->size() > 16384)) { Fail(callback, "Invalid secret"); return; }
      if (op == "secret.read" && profile()->GetPrefs()->GetString(kSecrets).empty()) {
        Reply(callback, base::Value("")); return;
      }
      g_browser_process->os_crypt_async()->GetInstance(base::BindOnce(
          &Handler::Secret, weak_.GetWeakPtr(), callback.Clone(), op, value ? *value : ""));
      return;
    }
    if (op == "secret.clear") {
      profile()->GetPrefs()->ClearPref(kSecrets); Persist(callback, base::Value(true)); return;
    }
    if (op == "blocker.open") {
      auto* window = browser();
      if (!window) { Fail(callback, "Browser window unavailable"); return; }
      NavigateParams params(window, GURL("chrome-extension://dcahalgkkhldgcodlieblmhfkjmggehp/options.html"), ui::PAGE_TRANSITION_TYPED);
      params.disposition = WindowOpenDisposition::NEW_FOREGROUND_TAB;
      Navigate(&params);
      Reply(callback, base::Value(true)); return;
    }
    if (op == "bookmarks.list") {
      auto* model = BookmarkModelFactory::GetForBrowserContext(profile());
      if (!model || !model->loaded()) { Fail(callback, "Bookmarks are still loading"); return; }
      base::ListValue result;
      std::vector<const bookmarks::BookmarkNode*> queue{model->root_node()};
      while (!queue.empty() && result.size() < 5000) {
        auto* current = queue.back(); queue.pop_back();
        if (current->is_url()) {
          base::DictValue bookmark;
          bookmark.Set("title", base::UTF16ToUTF8(current->GetTitle()));
          bookmark.Set("url", current->url().spec());
          result.Append(std::move(bookmark));
        }
        for (const auto& child : current->children()) queue.push_back(child.get());
      }
      Reply(callback, base::Value(std::move(result))); return;
    }
    auto* window = browser();
    if (!window) { Fail(callback, "Browser window unavailable"); return; }
    auto* tabs = window->GetTabStripModel();
    if (op == "tabs.list") {
      base::ListValue result;
      for (int i = 0; i < tabs->count(); ++i) {
        auto* contents = tabs->GetWebContentsAt(i);
        base::DictValue row;
        row.Set("index", i);
        row.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
        row.Set("url", contents->GetVisibleURL().spec());
        row.Set("active", i == tabs->active_index());
        row.Set("pinned", tabs->IsTabPinned(i));
        result.Append(std::move(row));
      }
      Reply(callback, base::Value(std::move(result))); return;
    }
    if (op == "navigate") {
      const auto* value = data.FindString("url");
      if (!value || value->size() > 8192) { Fail(callback, "Invalid URL"); return; }
      GURL url(*value);
      bool internal = url.SchemeIs("chrome") &&
        (url.host() == "boybrowse" || url.host() == "settings" || url.host() == "history" ||
         url.host() == "bookmarks" || url.host() == "downloads" || url.host() == "extensions");
      if (!url.is_valid() || (!url.SchemeIsHTTPOrHTTPS() && !internal)) { Fail(callback, "URL scheme not allowed"); return; }
      NavigateParams params(window, url, ui::PAGE_TRANSITION_TYPED);
      params.disposition = WindowOpenDisposition::NEW_FOREGROUND_TAB;
      Navigate(&params);
      Reply(callback, base::Value(true)); return;
    }
    if (op == "command") {
      const auto* name = data.FindString("name");
      if (!name) { Fail(callback, "Missing command"); return; }
      if (*name == "vertical") chrome::ToggleVerticalTabs(window);
      else if (*name == "private") chrome::NewIncognitoWindow(profile());
      else if (*name == "restore") chrome::ExecuteCommand(window, IDC_RESTORE_TAB);
      else if (*name == "reader") chrome::ExecuteCommand(window, IDC_SHOW_READING_MODE_SIDE_PANEL);
      else if (*name == "fullscreen") chrome::ExecuteCommand(window, IDC_FULLSCREEN);
      else { Fail(callback, "Unknown command"); return; }
      Reply(callback, base::Value(true)); return;
    }
    auto index = data.FindInt("index");
    if (!index || *index < 0 || *index >= tabs->count()) { Fail(callback, "Tab no longer exists"); return; }
    if (op == "tabs.activate") tabs->ActivateTabAt(*index);
    else if (op == "tabs.pin") tabs->SetTabPinned(*index, !tabs->IsTabPinned(*index));
    else if (op == "tabs.move") {
      auto target = data.FindInt("target");
      if (!target || *target < 0 || *target >= tabs->count()) { Fail(callback, "Invalid target"); return; }
      tabs->MoveWebContentsAt(*index, *target, false);
    } else if (op == "tabs.split") {
      auto target = data.FindInt("target");
      if (!target || *target < 0 || *target >= tabs->count() || *target == *index ||
          tabs->IsTabPinned(*index) != tabs->IsTabPinned(*target) ||
          tabs->GetTabGroupForTab(*index) != tabs->GetTabGroupForTab(*target)) {
        Fail(callback, "Select two tabs with the same pin and group state"); return;
      }
      tabs->AddToNewSplit({*index, *target}, split_tabs::SplitTabVisualData(),
                         split_tabs::SplitTabCreatedSource::kToolbarButton);
    } else if (op == "tabs.close") {
      // Reply before closing; closing this WebUI invalidates the handler.
      Reply(callback, base::Value(true));
      tabs->CloseWebContentsAt(*index, TabCloseTypes::CLOSE_CREATE_HISTORICAL_TAB);
      return;
    } else { Fail(callback, "Unknown operation"); return; }
    Reply(callback, base::Value(true));
  }
  base::WeakPtrFactory<Handler> weak_{this};
};
}  // namespace

BoybrowseUI::BoybrowseUI(content::WebUI* web_ui) : WebUIController(web_ui) {
  auto* source = content::WebUIDataSource::CreateAndAdd(Profile::FromWebUI(web_ui), "boybrowse");
  source->SetRequestFilter(
      base::BindRepeating([](const std::string& path) { return true; }),
      base::BindRepeating([](const std::string& path, content::WebUIDataSource::GotDataCallback callback) {
        auto name = path.empty() ? std::string("index.html") : path.substr(0, path.find('?'));
        for (const auto& resource : kBoybrowseResources) {
          if (name == resource.first) {
            std::move(callback).Run(base::MakeRefCounted<base::RefCountedString>(std::string(resource.second)));
            return;
          }
        }
        std::move(callback).Run(nullptr);
      }));
  source->OverrideContentSecurityPolicy(network::mojom::CSPDirectiveName::ConnectSrc,
      "connect-src 'self' https: http://127.0.0.1:*;");
  source->OverrideContentSecurityPolicy(network::mojom::CSPDirectiveName::ImgSrc,
      "img-src 'self' data:;");
  web_ui->AddMessageHandler(std::make_unique<Handler>());
}
BoybrowseUI::~BoybrowseUI() = default;
