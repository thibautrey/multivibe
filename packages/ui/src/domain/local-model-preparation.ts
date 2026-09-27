export type PreparationStage = 'awaiting-consent' | 'installing' | 'downloading' | 'preparing' | 'testing' | 'verifying-chat' | 'ready' | 'cancelled' | 'interrupted' | 'failed';
export type PreparationQuote = {
  hostId: string; hostName: string; modelId: string; variant: string;
  runtime: string; runtimeVersion: string; policyRevision: number;
  artifactDigest: string; downloadBytes: number; requiredDiskBytes: number;
  availableDiskBytes: number; reserveDiskBytes: number;
  compatibility: 'estimated-fit'; configurationKey: string;
  runtimeDownload?: {version:string;platform:string;sha256:string;bytes:number};
};
export type PreparationJob = {
  id: string; quote: PreparationQuote; consentDigest: string; stage: PreparationStage;
  createdAt: string; updatedAt: string; consentedAt?: string;
  progress?: { completedBytes: number; totalBytes: number };
  error?: string; chatModelId?: string; testedAt?: string;
};
