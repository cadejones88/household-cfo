/// <summary>
/// hhBankLedgerEntries: read-only view of Bank Account Ledger Entry for the Homestead app. API v2.0 has no bank ledger
/// entry entity, and the app needs the reconciliation state (Open, Statement No., Statement Line No., Closed at Date) to
/// move a transaction from Posted to Reconciled, and to match BC-native payments (PennyMac, Frontier) that BC's own
/// recurring journals post (spec: Transaction state machine, Posted -> Reconciled; Idempotency item 7).
///
///   GET .../api/cadejonescpa/homestead/v1.0/companies({id})/hhBankLedgerEntries?$filter=bankAccountNo eq 'CAPONE-CC' and open eq true
///   GET ...?$filter=externalDocumentNo eq 'HHAPP-PLD-20261020-ABCDEF12'
/// </summary>
page 50100 "HH Bank Ledger Entries"
{
    PageType = API;
    APIPublisher = 'cadejonescpa';
    APIGroup = 'homestead';
    APIVersion = 'v1.0';
    EntityName = 'hhBankLedgerEntry';
    EntitySetName = 'hhBankLedgerEntries';
    EntityCaption = 'HH Bank Ledger Entry';
    EntitySetCaption = 'HH Bank Ledger Entries';
    SourceTable = "Bank Account Ledger Entry";
    ODataKeyFields = SystemId;
    DelayedInsert = true;
    Editable = false;
    InsertAllowed = false;
    ModifyAllowed = false;
    DeleteAllowed = false;
    Extensible = false;

    layout
    {
        area(Content)
        {
            repeater(Entries)
            {
                field(id; Rec.SystemId)
                {
                    Caption = 'Id';
                    Editable = false;
                }
                field(entryNo; Rec."Entry No.")
                {
                    Caption = 'Entry No.';
                }
                field(bankAccountNo; Rec."Bank Account No.")
                {
                    Caption = 'Bank Account No.';
                }
                field(postingDate; Rec."Posting Date")
                {
                    Caption = 'Posting Date';
                }
                field(documentType; Rec."Document Type")
                {
                    Caption = 'Document Type';
                }
                field(documentNo; Rec."Document No.")
                {
                    Caption = 'Document No.';
                }
                field(externalDocumentNo; Rec."External Document No.")
                {
                    Caption = 'External Document No.';
                }
                field(description; Rec.Description)
                {
                    Caption = 'Description';
                }
                field(amount; Rec.Amount)
                {
                    Caption = 'Amount';
                }
                field(remainingAmount; Rec."Remaining Amount")
                {
                    Caption = 'Remaining Amount';
                }
                field(open; Rec.Open)
                {
                    Caption = 'Open';
                }
                field(statementStatus; Rec."Statement Status")
                {
                    Caption = 'Statement Status';
                }
                field(statementNo; Rec."Statement No.")
                {
                    Caption = 'Statement No.';
                }
                field(statementLineNo; Rec."Statement Line No.")
                {
                    Caption = 'Statement Line No.';
                }
                field(closedAtDate; Rec."Closed at Date")
                {
                    // VERIFY: "Closed at Date" is the base-app field name on table 271 (it is on Cust./Vendor Ledger
                    // Entry too); the adapter treats 0001-01-01 (an empty AL date) as "still open".
                    Caption = 'Closed at Date';
                }
                field(reversed; Rec.Reversed)
                {
                    Caption = 'Reversed';
                }
                field(reversedByEntryNo; Rec."Reversed by Entry No.")
                {
                    Caption = 'Reversed by Entry No.';
                }
                field(dimensionSetId; Rec."Dimension Set ID")
                {
                    Caption = 'Dimension Set ID';
                }
                field(lastModifiedDateTime; Rec.SystemModifiedAt)
                {
                    Caption = 'Last Modified Date Time';
                    Editable = false;
                }
            }
        }
    }
}
