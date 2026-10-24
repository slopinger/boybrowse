// Copyright 2026 slop. MIT license; see repository LICENSE.
#ifndef CHROME_BROWSER_UI_WEBUI_BOYBROWSE_BOYBROWSE_UI_H_
#define CHROME_BROWSER_UI_WEBUI_BOYBROWSE_BOYBROWSE_UI_H_
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/webui_config.h"
class BoybrowseUI : public content::WebUIController {
 public:
  explicit BoybrowseUI(content::WebUI* web_ui);
  ~BoybrowseUI() override;
};
class BoybrowseUIConfig : public content::DefaultWebUIConfig<BoybrowseUI> {
 public:
  BoybrowseUIConfig() : DefaultWebUIConfig("chrome", "boybrowse") {}
  bool IsWebUIEnabled(content::BrowserContext* context) override {
    return !context->IsOffTheRecord();
  }
};
#endif
