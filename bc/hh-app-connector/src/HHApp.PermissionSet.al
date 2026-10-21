/// <summary>
/// HH-APP: the one permission set assigned to the Homestead Entra application (Microsoft Entra Applications card in BC),
/// matching the spec's rights: read on G/L Account, Dimension, Dimension Value, Bank Account, G/L Entry, G/L Budget
/// Name, G/L Budget Entry, Bank Account Ledger Entry; insert, modify and delete on Gen. Journal Line; insert on
/// G/L Budget Entry; the three connector pages; no posting codeunit.
///
/// Posting: `codeunit "Gen. Jnl.-Post Batch" = X` is deliberately absent. It is added only when the first auto-post rules
/// (R2, R3, R7) pass their sandbox test and Cade approves them in writing (spec: Decisions, question 4), and then the
/// Microsoft.NAV.post action is called by the posting job for HHAPP/AUTOPOST only. Until then Cade posts FEEDS and
/// RECEIPTS himself in BC or from the Console.
///
/// AL permission sets cannot filter table rights by field value, so "Gen. Journal Line restricted to the HHAPP template"
/// is enforced by the adapter (it only ever resolves batches of its configured template) and audited by the Change Log
/// on Gen. Journal Line (BC change 4); a per-template security filter is set on the application's user card in BC if
/// Cade wants it enforced server-side too (runbook change 1, step 1.8).
/// </summary>
permissionset 72100 "HH-APP"
{
    Assignable = true;
    Caption = 'HH App Connector (Homestead)', MaxLength = 30;

    Permissions =
        // Objects of this extension
        tabledata "HH Doc Check Row" = RIMD,
        table "HH Doc Check Row" = X,
        page "HH Bank Ledger Entries" = X,
        page "HH Budget Entries" = X,
        page "HH Journal Line Check" = X,
        codeunit "HH Budget Name Check" = X,
        codeunit "HH AutoPost Defaults" = X,

        // The standard API v2.0 pages the app calls (Microsoft's _Exclude_APIV2_ app). The entitlement for an
        // application holding API.ReadWrite.All allows these pages, but BC still requires Execute on each from the
        // application's own permission sets: without it every call answered 403 "Sorry, the current permissions
        // prevented the action. (Page 30016 APIV2 - Journals Execute: _Exclude_APIV2_)" (sandbox run, 10/21/2026).
        // Execute on a page grants no data; the table rights below still decide what each page can read or write.
        page "APIV2 - Accounts" = X,
        page "APIV2 - Bank Accounts" = X,
        page "APIV2 - Dimensions" = X,
        page "APIV2 Dimension Values Entity" = X,
        page "APIV2 - Dimension Set Lines" = X,
        page "APIV2 - Journals" = X,
        page "APIV2 - JournalLines" = X,
        page "APIV2 - G/L Entries" = X,

        // Chart, dimensions, bank cards (API v2.0 accounts, dimensions, dimensionValues, bankAccounts)
        tabledata "G/L Account" = R,
        tabledata "G/L Account Category" = R,
        tabledata Dimension = R,
        tabledata "Dimension Value" = R,
        tabledata "Dimension Set Entry" = RI,
        tabledata "Dimension Set Tree Node" = RI,
        tabledata "Default Dimension" = R,
        tabledata "Dimension Combination" = R,
        tabledata "Dimension Value Combination" = R,
        tabledata "Bank Account" = R,
        tabledata "Bank Account Posting Group" = R,
        tabledata "General Ledger Setup" = R,
        tabledata "Source Code" = R,
        tabledata "Reason Code" = R,

        // Journals: drafts in the HHAPP batches (API v2.0 journals, journalLines)
        tabledata "Gen. Journal Template" = R,
        tabledata "Gen. Journal Batch" = R,
        tabledata "Gen. Journal Line" = RIMD,
        tabledata "No. Series" = R,
        tabledata "No. Series Line" = RM,
        tabledata "Change Log Entry" = RI,

        // Posted entries and reconciliation state (API v2.0 generalLedgerEntries, hhBankLedgerEntries)
        tabledata "G/L Entry" = R,
        tabledata "Bank Account Ledger Entry" = R,
        tabledata "Bank Account Statement" = R,
        tabledata "Bank Account Statement Line" = R,

        // Budgets (hhBudgetEntries insert, Analytics API read)
        tabledata "G/L Budget Name" = R,
        tabledata "G/L Budget Entry" = RI,

        // Webhook subscriptions: not listed. "Webhook Subscription" and "Webhook Notification" are OnPrem-scoped and a
        // cloud extension cannot name them (AL0296, found by the first compile on 10/21/2026); in the online service
        // the API runtime manages subscriptions for the calling application itself. If POST subscriptions is refused
        // on the sandbox, the fix is a Microsoft permission set for the application, not this extension.

        // Companies and the user's own session
        tabledata Company = R,
        tabledata "Company Information" = R,
        tabledata User = R;
        // "User Property" is OnPrem-scoped (AL0296, second compile 10/21/2026) and not needed online.

    // VERIFY on the sandbox with the HH-APP set alone assigned to the Entra application: GET companies, GET accounts,
    // POST journalLines in a $batch, POST subscriptions, GET hhJournalLineChecks. If the runtime refuses a call with a
    // permission error on a system table not listed here, add that table rather than assigning a Microsoft base set
    // (D365 BASIC / D365 READ) — those grant read on every business table.
    // The journal line deep insert of dimensionSetLines needs RI on Dimension Set Entry and Dimension Set Tree Node
    // (DimensionManagement.GetDimensionSetID creates the set); the Document No. from the batch's No. Series needs RM on
    // No. Series Line; Change Log Entry = RI covers BC change 4 once the Change Log is on.
}
