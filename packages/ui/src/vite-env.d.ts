/** Consumers may use Vite or another bundler; only these build hints are read. */
interface ImportMetaEnv { readonly DEV: boolean; readonly MODE: string; }
interface ImportMeta { readonly env: ImportMetaEnv; }
