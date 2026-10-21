/// <summary>
/// hhJournalLineChecks: one read answering "does this External Document No. exist anywhere?" across Gen. Journal Line
/// (drafts in any batch) and G/L Entry (posted), with where (template/batch or entry no.) and which (document no.,
/// posting date, account, amount). The Homestead adapter runs it before every write (spec: Idempotency and retries,
/// item 2) and after a post to read the entry numbers back.
///
///   GET .../api/cadejonescpa/homestead/v1.0/companies({id})/hhJournalLineChecks?$filter=externalDocumentNo eq 'HHAPP-PLD-20261020-ABCDEF12'
///   GET ...?$filter=startswith(externalDocumentNo,'HHAPP-') and postingDate ge 2026-09-05 and postingDate le 2026-10-20   (nightly poll)
///
/// The page sits on a temporary table and fills it in OnFindRecord from the filters the request carries, the same way
/// the base app's "Dimension Lines Entity" (page 5487) and "APIV2 - Dimension Set Lines" (page 30039) load their buffer
/// from the ParentId filter. A filter on externalDocumentNo is required; postingDate and journalBatchName filters are
/// passed through to the source tables; every other $filter term is applied by the page to the buffer afterwards.
/// </summary>
page 72102 "HH Journal Line Check"
{
    PageType = API;
    APIPublisher = 'cadejonescpa';
    APIGroup = 'homestead';
    APIVersion = 'v1.0';
    EntityName = 'hhJournalLineCheck';
    EntitySetName = 'hhJournalLineChecks';
    EntityCaption = 'HH Journal Line Check';
    EntitySetCaption = 'HH Journal Line Checks';
    SourceTable = "HH Doc Check Row";
    SourceTableTemporary = true;
    ODataKeyFields = "Row No.";
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
            repeater(Rows)
            {
                field(rowNo; Rec."Row No.")
                {
                    Caption = 'Row No.';
                }
                field(externalDocumentNo; Rec."External Document No.")
                {
                    Caption = 'External Document No.';
                }
                field(source; Rec.Source)
                {
                    Caption = 'Source';
                }
                field(journalTemplateName; Rec."Journal Template Name")
                {
                    Caption = 'Journal Template Name';
                }
                field(journalBatchName; Rec."Journal Batch Name")
                {
                    Caption = 'Journal Batch Name';
                }
                field(lineNo; Rec."Line No.")
                {
                    Caption = 'Line No.';
                }
                field(lineSystemId; Rec."Line SystemId")
                {
                    Caption = 'Line SystemId';
                }
                field(entryNo; Rec."Entry No.")
                {
                    Caption = 'Entry No.';
                }
                field(documentNo; Rec."Document No.")
                {
                    Caption = 'Document No.';
                }
                field(postingDate; Rec."Posting Date")
                {
                    Caption = 'Posting Date';
                }
                field(accountType; Rec."Account Type")
                {
                    Caption = 'Account Type';
                }
                field(accountNo; Rec."Account No.")
                {
                    Caption = 'Account No.';
                }
                field(amount; Rec.Amount)
                {
                    Caption = 'Amount';
                }
                field(dimensionSetId; Rec."Dimension Set ID")
                {
                    Caption = 'Dimension Set ID';
                }
                field(sourceCode; Rec."Source Code")
                {
                    Caption = 'Source Code';
                }
                field(reasonCode; Rec."Reason Code")
                {
                    Caption = 'Reason Code';
                }
            }
        }
    }

    var
        RowsLoaded: Boolean;
        ExtDocFilterRequiredErr: Label 'hhJournalLineChecks needs a $filter on externalDocumentNo (an exact value or startswith).';

    trigger OnFindRecord(Which: Text): Boolean
    begin
        // VERIFY: OnFindRecord fires for API pages on a temporary source table (page 5487 relies on it); if the
        // sandbox returns an empty collection, move the load into OnOpenPage and keep the filter pass-through.
        if not RowsLoaded then begin
            LoadRows();
            RowsLoaded := true;
        end;
        exit(Rec.Find(Which));
    end;

    trigger OnNextRecord(Steps: Integer): Integer
    begin
        exit(Rec.Next(Steps));
    end;

    local procedure LoadRows()
    var
        FilterView: Text;
        ExtDocFilter: Text;
        PostingDateFilter: Text;
        BatchFilter: Text;
        RowNo: Integer;
    begin
        // The OData $filter arrives as table filters on the temporary record. Read the ones the source tables can
        // use, drop everything, fill, then put the whole view back so the page applies the remaining terms itself.
        FilterView := Rec.GetView(false);
        ExtDocFilter := Rec.GetFilter("External Document No.");
        PostingDateFilter := Rec.GetFilter("Posting Date");
        BatchFilter := Rec.GetFilter("Journal Batch Name");
        if ExtDocFilter = '' then
            Error(ExtDocFilterRequiredErr);

        Rec.Reset();
        Rec.DeleteAll();
        RowNo := 0;
        LoadJournalLines(ExtDocFilter, PostingDateFilter, BatchFilter, RowNo);
        LoadLedgerEntries(ExtDocFilter, PostingDateFilter, RowNo);
        Rec.SetView(FilterView);
    end;

    local procedure LoadJournalLines(ExtDocFilter: Text; PostingDateFilter: Text; BatchFilter: Text; var RowNo: Integer)
    var
        GenJnlLine: Record "Gen. Journal Line";
    begin
        // VERIFY: a filter expression read with GetFilter (for example HHAPP-PLD-20261020-ABCDEF12 or HHAPP-*) is
        // accepted unchanged by SetFilter on the source table; the document numbers contain only A-Z, 0-9 and '-'.
        GenJnlLine.SetFilter("External Document No.", ExtDocFilter);
        if PostingDateFilter <> '' then
            GenJnlLine.SetFilter("Posting Date", PostingDateFilter);
        if BatchFilter <> '' then
            GenJnlLine.SetFilter("Journal Batch Name", BatchFilter);
        if GenJnlLine.FindSet() then
            repeat
                RowNo += 1;
                Rec.Init();
                Rec."Row No." := RowNo;
                Rec."External Document No." := GenJnlLine."External Document No.";
                Rec.Source := Rec.Source::Journal;
                Rec."Journal Template Name" := GenJnlLine."Journal Template Name";
                Rec."Journal Batch Name" := GenJnlLine."Journal Batch Name";
                Rec."Line No." := GenJnlLine."Line No.";
                Rec."Line SystemId" := GenJnlLine.SystemId;
                Rec."Entry No." := 0;
                Rec."Document No." := GenJnlLine."Document No.";
                Rec."Posting Date" := GenJnlLine."Posting Date";
                Rec."Account Type" := GenJnlLine."Account Type";
                Rec."Account No." := GenJnlLine."Account No.";
                Rec.Amount := GenJnlLine.Amount;
                Rec."Dimension Set ID" := GenJnlLine."Dimension Set ID";
                Rec."Source Code" := GenJnlLine."Source Code";
                Rec."Reason Code" := GenJnlLine."Reason Code";
                Rec.Insert();
            until GenJnlLine.Next() = 0;
    end;

    local procedure LoadLedgerEntries(ExtDocFilter: Text; PostingDateFilter: Text; var RowNo: Integer)
    var
        GLEntry: Record "G/L Entry";
    begin
        // G/L Entry has no key on External Document No. in the base app; at household volume (a few thousand entries a
        // year) the scan is fine. If the sandbox query is slow, add a table extension with key(HHExtDoc; "External Document No.").
        GLEntry.SetFilter("External Document No.", ExtDocFilter);
        if PostingDateFilter <> '' then
            GLEntry.SetFilter("Posting Date", PostingDateFilter);
        if GLEntry.FindSet() then
            repeat
                RowNo += 1;
                Rec.Init();
                Rec."Row No." := RowNo;
                Rec."External Document No." := GLEntry."External Document No.";
                Rec.Source := Rec.Source::Ledger;
                Rec."Journal Template Name" := '';
                Rec."Journal Batch Name" := GLEntry."Journal Batch Name";
                Rec."Line No." := 0;
                Clear(Rec."Line SystemId");
                Rec."Entry No." := GLEntry."Entry No.";
                Rec."Document No." := GLEntry."Document No.";
                Rec."Posting Date" := GLEntry."Posting Date";
                Rec."Account Type" := Rec."Account Type"::"G/L Account";
                Rec."Account No." := GLEntry."G/L Account No.";
                Rec.Amount := GLEntry.Amount;
                Rec."Dimension Set ID" := GLEntry."Dimension Set ID";
                Rec."Source Code" := GLEntry."Source Code";
                Rec."Reason Code" := GLEntry."Reason Code";
                Rec.Insert();
            until GLEntry.Next() = 0;
    end;
}
