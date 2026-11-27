import ModalPortal from "../components/ModalPortal";
import { useT } from "../i18n";
import { useState } from "react";
import { HostHarnessCards } from "./HostHarnessCarousel";

type Props = {
  accountCount: number;
  cloudUrl: string;
  onComplete: () => void;
  onHarnessesChanged: () => Promise<void>;
  onOpenProviderSetup: () => void;
};

const STEPS = ["Harness", "Provider", "Cloud"];

export function HostOnboarding({
  accountCount,
  cloudUrl,
  onComplete,
  onHarnessesChanged,
  onOpenProviderSetup,
}: Props) {
  const t = useT();
  const [step, setStep] = useState(0);

  return (
    <ModalPortal><div className="modal-backdrop host-onboarding-backdrop" role="presentation">
      <section
        className="modal panel host-onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-onboarding-title"
      >
        <header className="host-onboarding-header">
          <div>
            <span className="eyebrow">{t("Welcome to MultiVibe Host")}</span>
            <div className="host-onboarding-steps" aria-label={t("Step {current} of {total}", { current: step + 1, total: STEPS.length })}>
              {STEPS.map((label, index) => (
                <span className={index === step ? "active" : index < step ? "complete" : ""} key={label}>
                  <i aria-hidden="true">{index + 1}</i>
                  {t(label)}
                </span>
              ))}
            </div>
          </div>
          <button className="btn ghost host-onboarding-skip" type="button" onClick={onComplete}>
            {t("Skip setup")}
          </button>
        </header>

        <div className="host-onboarding-content">
          {step === 0 && (
            <>
              <div className="host-onboarding-copy">
                <h2 id="host-onboarding-title">{t("Connect your coding tool")}</h2>
                <p>{t("Choose a detected harness. You can change this later.")}</p>
              </div>
              <HostHarnessCards variant="onboarding" onApiKeysChanged={onHarnessesChanged} />
            </>
          )}

          {step === 1 && (
            <div className="host-onboarding-simple-step">
              <div className="host-onboarding-step-icon" aria-hidden="true">+</div>
              <div className="host-onboarding-copy">
                <h2 id="host-onboarding-title">{t("Add a provider")}</h2>
                <p>{t("Connect one account so MultiVibe has models to route.")}</p>
              </div>
              {accountCount > 0 ? (
                <div className="host-onboarding-ready" role="status">
                  <span aria-hidden="true">✓</span>
                  {t("Provider connected")}
                </div>
              ) : (
                <button className="btn" type="button" onClick={onOpenProviderSetup}>
                  {t("Configure a provider")}
                </button>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="host-onboarding-simple-step">
              <img className="host-onboarding-cloud-icon" src="/assets/brand/multivibe-app-icon.svg" alt="" />
              <div className="host-onboarding-copy">
                <span className="badge">{t("Optional")}</span>
                <h2 id="host-onboarding-title">{t("Connect MultiVibe Cloud")}</h2>
                <p>{t("Sign in to your cloud account, or do this later.")}</p>
              </div>
              <a className="btn secondary" href={cloudUrl} target="_blank" rel="noreferrer">
                {t("Open MultiVibe Cloud")}
              </a>
            </div>
          )}
        </div>

        <footer className="host-onboarding-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={step === 0}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
          >
            {t("Back")}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              className="btn"
              type="button"
              disabled={step === 1 && accountCount === 0}
              onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}
            >
              {t("Continue")}
            </button>
          ) : (
            <button className="btn" type="button" onClick={onComplete}>
              {t("Finish")}
            </button>
          )}
        </footer>
      </section>
    </div></ModalPortal>
  );
}
