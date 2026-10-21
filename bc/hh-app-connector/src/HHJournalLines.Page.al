/// <summary>
/// hhJournalLines: insert and read Homestead's draft lines in the HHAPP journal batches, with the line's dimensions in
/// the same request. Added in 1.0.0.3 because the standard journalLines API cannot set a dimension the account
/// already carries as a default: BC applies the account's default dimensions when the line is inserted, and the
/// deep insert of dimensionSetLines then fails "The dimension set line already exists" for every such code (page
/// 30022 "APIV2 - Dimension Set Lines", RecordAlreadyExistErr). Nearly every household account has defaults.
///
///   POST .../api/cadejonescpa/homestead/v1.0/companies({id})/hhJournalLines   (one JSON $batch per document,
///        header Isolation: snapshot, so the whole document lands or nothing does)
///   { "journalId": "<HHAPP batch SystemId>", "accountType": "G/L Account", "accountNumber": "603101",
///     "postingDate": "2026-10-19", "externalDocumentNumber": "HHAPP-RCP-20261019-1a2b3c4d", "amount": 42.17,
///     "description": "Broulim's", "comment": "plaid:…",
///     "dimensions": "SPEND_CLASS=ESSENTIAL|FAMILY_AREA=JOINT|TAX_TREATMENT=NONDEDUCT" }
///
/// The line is built exactly as page 30049 builds it (Graph Mgt - Journal Lines, Library API - General Journal: Line No.
/// and Document No. from the batch No. Series, consecutive lines with one External Document No. share a Document No.),
/// then the given dimensions are laid over the account's defaults: a code in "dimensions" replaces the default value,
/// a code with an empty value removes it, defaults not named stay. A dimension value that does not exist or is blocked
/// is an error, so the whole $batch rolls back. Only the HHAPP template is readable or writable through this page.
/// </summary>
page 72103 "HH Journal Lines"
{
    PageType = API;
    APIPublisher = 'cadejonescpa';
    APIGroup = 'homestead';
    APIVersion = 'v1.0';
    EntityName = 'hhJournalLine';
    EntitySetName = 'hhJournalLines';
    EntityCaption = 'HH Journal Line';
    EntitySetCaption = 'HH Journal Lines';
    SourceTable = "Gen. Journal Line";
    SourceTableView = where("Journal Template Name" = const('HHAPP'));
    ODataKeyFields = SystemId;
    DelayedInsert = true;
    InsertAllowed = true;
    ModifyAllowed = false;
    DeleteAllowed = false;
    Extensible = false;

    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field(id; Rec.SystemId)
                {
                    Caption = 'Id';
                    Editable = false;
                }
                field(journalId; Rec."Journal Batch Id")
                {
                    Caption = 'Journal Id';
                }
                field(journalBatchName; Rec."Journal Batch Name")
                {
                    Caption = 'Journal Batch Name';
                    Editable = false;
                }
                field(lineNumber; Rec."Line No.")
                {
                    Caption = 'Line No.';
                    Editable = false;
                }
                field(accountType; Rec."Account Type")
                {
                    Caption = 'Account Type';
                }
                field(accountNumber; Rec."Account No.")
                {
                    Caption = 'Account No.';
                }
                field(postingDate; Rec."Posting Date")
                {
                    Caption = 'Posting Date';
                }
                field(documentNumber; Rec."Document No.")
                {
                    Caption = 'Document No.';
                    Editable = false;
                }
                field(externalDocumentNumber; Rec."External Document No.")
                {
                    Caption = 'External Document No.';
                }
                field(amount; Rec.Amount)
                {
                    Caption = 'Amount';
                }
                field(description; Rec.Description)
                {
                    Caption = 'Description';
                }
                field(comment; Rec.Comment)
                {
                    Caption = 'Comment';
                }
                field(dimensions; DimensionsTxt)
                {
                    Caption = 'Dimensions';
                }
                field(dimensionSetId; Rec."Dimension Set ID")
                {
                    Caption = 'Dimension Set ID';
                    Editable = false;
                }
                field(lastModifiedDateTime; Rec.SystemModifiedAt)
                {
                    Caption = 'Last Modified Date Time';
                    Editable = false;
                }
            }
        }
    }

    var
        GraphMgtJournalLines: Codeunit "Graph Mgt - Journal Lines";
        LibraryAPIGeneralJournal: Codeunit "Library API - General Journal";
        DimensionsTxt: Text[250];
        HHAppTemplateTok: Label 'HHAPP', Locked = true;
        JournalIdRequiredErr: Label 'The "journalId" of an HHAPP journal batch must be given.', Comment = 'journalId is a field name and should not be translated.';
        WrongTemplateErr: Label 'Only the %1 journal template is open to the Homestead app; batch %2 belongs to template %3.', Comment = '%1 = HHAPP, %2 = batch name, %3 = its template';
        AccountTypeErr: Label 'Homestead draft lines use account type G/L Account or Bank Account only.';
        DimensionPairErr: Label 'The "dimensions" value must be CODE=VALUE pairs separated by |, not "%1".', Comment = '%1 = the offending pair; dimensions is a field name and should not be translated.';
        BlockedDimValueErr: Label 'Dimension value %1 %2 is blocked.', Comment = '%1 = dimension code, %2 = value code';

    trigger OnNewRecord(BelowxRec: Boolean)
    begin
        Clear(DimensionsTxt);
        Rec."Document Type" := Rec."Document Type"::" ";
        Rec."Account Type" := Rec."Account Type"::"G/L Account";
    end;

    trigger OnAfterGetRecord()
    begin
        DimensionsTxt := DimensionsOf(Rec."Dimension Set ID");
    end;

    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        GenJournalBatch: Record "Gen. Journal Batch";
        TempGenJournalLine: Record "Gen. Journal Line" temporary;
    begin
        if IsNullGuid(Rec."Journal Batch Id") then
            Error(JournalIdRequiredErr);
        if not (Rec."Account Type" in [Rec."Account Type"::"G/L Account", Rec."Account Type"::"Bank Account"]) then
            Error(AccountTypeErr);

        TempGenJournalLine.Copy(Rec);
        Clear(Rec);
        GenJournalBatch.GetBySystemId(TempGenJournalLine."Journal Batch Id");
        if GenJournalBatch."Journal Template Name" <> HHAppTemplateTok then
            Error(WrongTemplateErr, HHAppTemplateTok, GenJournalBatch.Name, GenJournalBatch."Journal Template Name");

        // As page 30049 "APIV2 - JournalLines" does it.
        GraphMgtJournalLines.SetJournalLineTemplateAndBatchV2(Rec, GenJournalBatch);
        LibraryAPIGeneralJournal.InitializeLine(Rec, 0, '', TempGenJournalLine."External Document No.");
        GraphMgtJournalLines.SetJournalLineValues(Rec, TempGenJournalLine);

        // The account's default dimensions are on the line now; lay the requested ones over them.
        ApplyDimensions(DimensionsTxt);
    end;

    local procedure ApplyDimensions(Spec: Text)
    var
        TempDimSetEntry: Record "Dimension Set Entry" temporary;
        DimValue: Record "Dimension Value";
        DimMgt: Codeunit DimensionManagement;
        Pairs: List of [Text];
        Parts: List of [Text];
        Pair: Text;
        DimCode: Code[20];
        ValueCode: Code[20];
    begin
        if Spec.Trim() = '' then
            exit;
        DimMgt.GetDimensionSet(TempDimSetEntry, Rec."Dimension Set ID");
        Pairs := Spec.Split('|');
        foreach Pair in Pairs do
            if Pair.Trim() <> '' then begin
                Parts := Pair.Split('=');
                if Parts.Count() <> 2 then
                    Error(DimensionPairErr, Pair);
                DimCode := CopyStr(Parts.Get(1).Trim().ToUpper(), 1, MaxStrLen(DimCode));
                ValueCode := CopyStr(Parts.Get(2).Trim().ToUpper(), 1, MaxStrLen(ValueCode));
                if DimCode = '' then
                    Error(DimensionPairErr, Pair);
                TempDimSetEntry.SetRange("Dimension Code", DimCode);
                TempDimSetEntry.DeleteAll();
                TempDimSetEntry.SetRange("Dimension Code");
                if ValueCode <> '' then begin
                    // A value the dimension does not have is an error, not a silently dropped dimension.
                    DimValue.Get(DimCode, ValueCode);
                    if DimValue.Blocked then
                        Error(BlockedDimValueErr, DimCode, ValueCode);
                    TempDimSetEntry.Init();
                    TempDimSetEntry."Dimension Set ID" := Rec."Dimension Set ID";
                    TempDimSetEntry."Dimension Code" := DimCode;
                    TempDimSetEntry."Dimension Value Code" := ValueCode;
                    TempDimSetEntry."Dimension Value ID" := DimValue."Dimension Value ID";
                    TempDimSetEntry.Insert();
                end;
            end;
        Rec."Dimension Set ID" := DimMgt.GetDimensionSetID(TempDimSetEntry);
        DimMgt.UpdateGlobalDimFromDimSetID(Rec."Dimension Set ID", Rec."Shortcut Dimension 1 Code", Rec."Shortcut Dimension 2 Code");
    end;

    local procedure DimensionsOf(DimSetId: Integer): Text[250]
    var
        TempDimSetEntry: Record "Dimension Set Entry" temporary;
        DimMgt: Codeunit DimensionManagement;
        Result: Text;
    begin
        if DimSetId = 0 then
            exit('');
        DimMgt.GetDimensionSet(TempDimSetEntry, DimSetId);
        if TempDimSetEntry.FindSet() then
            repeat
                if Result <> '' then
                    Result += '|';
                Result += TempDimSetEntry."Dimension Code" + '=' + TempDimSetEntry."Dimension Value Code";
            until TempDimSetEntry.Next() = 0;
        exit(CopyStr(Result, 1, 250));
    end;
}
