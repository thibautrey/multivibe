import { useT } from "../i18n";

/** Settings labels follow the ChatGPT UI; illustrations are not interactive controls. */
export function ChatGPTDeviceGuide() {
  const t = useT();
  return <section className="device-guide" aria-label={t("Enable ChatGPT device sign-in")}>
    <div className="device-guide-heading"><strong>{t("First time using device sign-in?")}</strong><a href="https://chatgpt.com" target="_blank" rel="noreferrer">{t("Open ChatGPT")} ↗</a></div>
    <p>{t("You may need to enable it in ChatGPT first.")}</p>
    <ol className="device-guide-steps">
      <li><span className="device-step-number">1</span><strong>{t("Open your account menu")}</strong><div className="device-guide-example"><span aria-hidden="true">◉</span> {t("My Account")} <span aria-hidden="true">⌄</span></div></li>
      <li><span className="device-step-number">2</span><strong>{t("Go to settings")}</strong><div className="device-guide-example">{t("Settings")} <span aria-hidden="true">→</span><b>{t("Security and login")}</b></div></li>
      <li><span className="device-step-number">3</span><strong>{t("Enable device codes")}</strong><div className="device-guide-example"><span>{t("Enable device code authorization for Codex")}</span><span className="device-guide-toggle" aria-label={t("Illustration: enabled")} /></div></li>
    </ol>
    <p className="device-guide-note">{t("Then return here to get your code. Only approve a code you requested; never share it. For a managed workspace, your admin may need to allow device sign-in.")}</p>
    <a className="device-guide-docs" href="https://developers.openai.com/codex/auth#login-on-headless-devices" target="_blank" rel="noreferrer">{t("OpenAI sign-in help")} ↗</a>
  </section>;
}
