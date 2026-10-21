/**
 * @homestead/ledger-adapter-bc — the ledger adapter interface and its Business Central implementation.
 * See README.md for the shape of the package and what is faked.
 */
export type {
  AppDocumentFilter,
  AppDocumentRow,
  BankLedgerEntry,
  BankLedgerEntryFilter,
  BudgetEntryInput,
  BudgetRead,
  BudgetReadLine,
  BudgetReadOptions,
  CreateJournalLinesRequest,
  CreateJournalLinesResult,
  CreateSubscriptionRequest,
  ExternalDocLookup,
  JournalLineInput,
  LedgerAccount,
  LedgerAdapter,
  LedgerBankAccount,
  LedgerDimension,
  LedgerDimensionValue,
  LedgerEntry,
  LedgerEntryRef,
  SubscriptionsApi,
  WebhookResource,
  WebhookSubscription,
  WriteBudgetEntriesResult,
  WrittenJournalLine,
} from "./types.js";

export {
  API_ANALYTICS,
  API_CONNECTOR,
  API_RUNTIME,
  API_V2,
  BUDGET_NAME_MAX,
  BusinessCentralAdapter,
  COMMENT_MAX,
  CONNECTOR_GROUP,
  CONNECTOR_PUBLISHER,
  CONNECTOR_VERSION,
  DEFAULT_BUDGET_DIMENSION_LAYOUT,
  DESCRIPTION_MAX,
  assertExternalDocNo,
  assertWritableBudgetName,
  isOrigBudgetName,
  toBcLineBody,
  truncateDescription,
  validateLines,
  type BcAdapterConfig,
  type BudgetDimensionLayout,
} from "./bcAdapter.js";

export { BcHttp, type BatchFormat, type BcHttpConfig, type BcResponse } from "./http.js";

export {
  ASSERTION_LIFETIME_S,
  BC_SCOPE,
  CLIENT_ASSERTION_TYPE,
  CertificateCredential,
  StaticTokenProvider,
  TOKEN_REFRESH_MARGIN_MS,
  parsePemBundle,
  type CertificateCredentialConfig,
  type ParsedPemBundle,
  type TokenProvider,
} from "./auth.js";

export { BcNonRetryableError, BcRetryableError, LedgerAdapterError, isRetryableStatus, parseBcError, type BcErrorBody } from "./errors.js";

export { BACKOFF_MINUTES, HOURLY_RETRIES, MAX_RETRY_ATTEMPTS, isRetryable, nextRetryDelayMs, retryDelayFor, totalScheduleMs } from "./retry.js";

export { buildJsonBatch, buildMultipartChangeset, odataDate, odataString, parseJsonBatchResponse, parseMultipartBatchResponse, type BatchRequest, type BatchResponsePart } from "./odata.js";

export {
  ACCOUNT_CARD_PAYMENT_CLEARING,
  ACCOUNT_CTJ_PAID_PERSONAL,
  ACCOUNT_DUE_FROM_CTJ,
  ACCOUNT_TRANSFER_CLEARING,
  MappingError,
  mapTransactionToJournalLines,
  paycheckLinesToSplits,
  type AppSplitForLedger,
  type AppTransactionForLedger,
  type MappedDocument,
} from "./mapping.js";

export { redactString } from "./scrub.js";

export { MockBcServer, type MockBcServerOptions, type MockRequestLog } from "./mock/MockBcServer.js";
