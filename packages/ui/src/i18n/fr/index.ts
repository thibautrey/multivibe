import shared from "./shared";
import app from "./app";
import overview from "./overview";
import models from "./models";
import accounts from "./accounts";
import providers from "./providers";
import sessions from "./sessions";
import invoices from "./invoices";
import routing from "./routing";
import activity from "./activity";
import api from "./api";
import docs from "./docs";
import plugins from "./plugins";
import updates from "./updates";
import host from "./host";
import users from "./users";
import audio from "./audio";

/**
 * French catalog keyed by the exact English source string used in the UI.
 * Keeping English as the key makes omissions explicit and keeps the fallback
 * readable; `web/test/i18n.test.ts` checks coverage and duplicate entries.
 */
export const FR_CATALOG: Record<string, string> = {
  ...shared,
  ...app,
  ...overview,
  ...models,
  ...accounts,
  ...providers,
  ...sessions,
  ...invoices,
  ...routing,
  ...activity,
  ...api,
  ...docs,
  ...plugins,
  ...updates,
  ...host,
  ...users,
  ...audio,
};

export {
  shared as sharedCatalog,
  app as appCatalog,
  overview as overviewCatalog,
  models as modelsCatalog,
  accounts as accountsCatalog,
  providers as providersCatalog,
  sessions as sessionsCatalog,
  invoices as invoicesCatalog,
  routing as routingCatalog,
  activity as activityCatalog,
  api as apiCatalog,
  docs as docsCatalog,
  plugins as pluginsCatalog,
  updates as updatesCatalog,
  host as hostCatalog,
  users as usersCatalog,
  audio as audioCatalog,
};
