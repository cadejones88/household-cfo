/// <summary>
/// hhBudgetEntries: insert and read over G/L Budget Entry for versioned budget revisions (acceptance test A8). The app
/// writes an approved budget move as new entries in a revision budget (2026-REV3) or a forecast (FCST2026Q4) with the
/// revision number in Description; the original budget (*-ORIG) is refused on insert. Reads of budgets for the app's
/// screens go through the read-only Analytics API (generalLedgerBudget / generalLedgerBudgetEntry); this page's read
/// side exists so a write can be verified by the same route that made it.
///
///   POST .../api/cadejonescpa/homestead/v1.0/companies({id})/hhBudgetEntries   (one $batch change set per revision)
///   { "budgetName": "2026-REV3", "glAccountNo": "603101", "date": "2026-11-01", "amount": 600.00,
///     "description": "REV 3", "globalDimension1Code": "ESSENTIAL", "globalDimension2Code": "",
///     "budgetDimension1Code": "JOINT", "budgetDimension2Code": "NONDEDUCT", "budgetDimension3Code": "", "budgetDimension4Code": "" }
///
/// Dimension layout (BC Setup Design): Global 1 SPEND_CLASS, Global 2 FUND_GOAL; the G/L Budget Name card assigns
/// Budget Dimension 1-4 (FAMILY_AREA, TAX_TREATMENT, PROJECT, blank). The adapter's DEFAULT_BUDGET_DIMENSION_LAYOUT
/// mirrors that order; keep them in step.
/// </summary>
page 50101 "HH Budget Entries"
{
    PageType = API;
    APIPublisher = 'cadejonescpa';
    APIGroup = 'homestead';
    APIVersion = 'v1.0';
    EntityName = 'hhBudgetEntry';
    EntitySetName = 'hhBudgetEntries';
    EntityCaption = 'HH Budget Entry';
    EntitySetCaption = 'HH Budget Entries';
    SourceTable = "G/L Budget Entry";
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
                    Editable = false;
                }
                field(budgetName; Rec."Budget Name")
                {
                    Caption = 'Budget Name';
                }
                field(glAccountNo; Rec."G/L Account No.")
                {
                    Caption = 'G/L Account No.';
                }
                field(date; Rec.Date)
                {
                    Caption = 'Date';
                }
                field(amount; Rec.Amount)
                {
                    Caption = 'Amount';
                }
                field(description; Rec.Description)
                {
                    Caption = 'Description';
                }
                field(globalDimension1Code; Rec."Global Dimension 1 Code")
                {
                    Caption = 'Global Dimension 1 Code';
                }
                field(globalDimension2Code; Rec."Global Dimension 2 Code")
                {
                    Caption = 'Global Dimension 2 Code';
                }
                field(budgetDimension1Code; Rec."Budget Dimension 1 Code")
                {
                    Caption = 'Budget Dimension 1 Code';
                }
                field(budgetDimension2Code; Rec."Budget Dimension 2 Code")
                {
                    Caption = 'Budget Dimension 2 Code';
                }
                field(budgetDimension3Code; Rec."Budget Dimension 3 Code")
                {
                    Caption = 'Budget Dimension 3 Code';
                }
                field(budgetDimension4Code; Rec."Budget Dimension 4 Code")
                {
                    Caption = 'Budget Dimension 4 Code';
                }
                field(dimensionSetId; Rec."Dimension Set ID")
                {
                    Caption = 'Dimension Set ID';
                    Editable = false;
                }
                field(userId; Rec."User ID")
                {
                    Caption = 'User ID';
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
        HHBudgetNameCheck: Codeunit "HH Budget Name Check";

    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        GLBudgetEntry: Record "G/L Budget Entry";
    begin
        HHBudgetNameCheck.AssertWritable(Rec."Budget Name");
        Rec.TestField("G/L Account No.");
        Rec.TestField(Date);
        // VERIFY: "Entry No." on table 96 is AutoIncrement in the base app, in which case this block never runs.
        // It stays as a guard so a non-autoincrement platform still gets a unique key.
        if Rec."Entry No." = 0 then begin
            GLBudgetEntry.LockTable();
            if GLBudgetEntry.FindLast() then
                Rec."Entry No." := GLBudgetEntry."Entry No." + 1
            else
                Rec."Entry No." := 1;
        end;
        Rec."User ID" := CopyStr(UserId(), 1, MaxStrLen(Rec."User ID"));
        Rec."Last Date Modified" := Today();
        UpdateDimensionSetId();
        exit(true);
    end;

    /// <summary>
    /// The budget matrix keeps "Dimension Set ID" in step with the six code fields; an API insert bypasses that UI code,
    /// so the set is built here from the codes so dimension analyses (and the Analytics API) see the revision correctly.
    /// </summary>
    local procedure UpdateDimensionSetId()
    var
        GLBudgetName: Record "G/L Budget Name";
        GLSetup: Record "General Ledger Setup";
        TempDimSetEntry: Record "Dimension Set Entry" temporary;
        DimMgt: Codeunit DimensionManagement;
    begin
        GLSetup.Get();
        GLBudgetName.Get(Rec."Budget Name");
        AddDim(TempDimSetEntry, GLSetup."Global Dimension 1 Code", Rec."Global Dimension 1 Code");
        AddDim(TempDimSetEntry, GLSetup."Global Dimension 2 Code", Rec."Global Dimension 2 Code");
        AddDim(TempDimSetEntry, GLBudgetName."Budget Dimension 1 Code", Rec."Budget Dimension 1 Code");
        AddDim(TempDimSetEntry, GLBudgetName."Budget Dimension 2 Code", Rec."Budget Dimension 2 Code");
        AddDim(TempDimSetEntry, GLBudgetName."Budget Dimension 3 Code", Rec."Budget Dimension 3 Code");
        AddDim(TempDimSetEntry, GLBudgetName."Budget Dimension 4 Code", Rec."Budget Dimension 4 Code");
        // VERIFY: DimensionManagement.GetDimensionSetID(var TempDimSetEntry) is the base-app signature (it returns 0 for an empty set).
        Rec."Dimension Set ID" := DimMgt.GetDimensionSetID(TempDimSetEntry);
    end;

    local procedure AddDim(var TempDimSetEntry: Record "Dimension Set Entry" temporary; DimensionCode: Code[20]; ValueCode: Code[20])
    var
        DimValue: Record "Dimension Value";
    begin
        if (DimensionCode = '') or (ValueCode = '') then
            exit;
        // A value the dimension does not have is an error, not a silently dropped dimension.
        DimValue.Get(DimensionCode, ValueCode);
        TempDimSetEntry.Init();
        TempDimSetEntry."Dimension Set ID" := 0;
        TempDimSetEntry."Dimension Code" := DimensionCode;
        TempDimSetEntry."Dimension Value Code" := ValueCode;
        TempDimSetEntry."Dimension Value ID" := DimValue."Dimension Value ID";
        TempDimSetEntry.Insert();
    end;
}
