/// <summary>
/// The budget-name whitelist for hhBudgetEntries (spec: HH App Connector table). The app writes versioned revisions and
/// forecasts only; the original budget of a year is never touched by the app, so a name ending in -ORIG is refused even
/// when a caller bypasses the adapter's own client-side check. Kept in a codeunit so a test codeunit can call it directly.
/// </summary>
codeunit 72100 "HH Budget Name Check"
{
    var
        OrigRefusedErr: Label 'Budget %1 is an original budget and is never changed by the Homestead app.', Comment = '%1 = budget name';
        NotWhitelistedErr: Label 'Budget %1 is not a revision (*-REV*) or a forecast (FCST*).', Comment = '%1 = budget name';
        BlankErr: Label 'Budget Name must have a value in G/L Budget Entry.';
        BlockedErr: Label 'Budget %1 is blocked.', Comment = '%1 = budget name';

    /// <summary>True when the name may be written by the app: *-REV* or FCST*, never *-ORIG.</summary>
    procedure IsWritable(BudgetName: Code[10]): Boolean
    var
        Name: Text;
    begin
        Name := UpperCase(BudgetName);
        if Name = '' then
            exit(false);
        if Name.EndsWith('-ORIG') then
            exit(false);
        exit((StrPos(Name, '-REV') > 0) or Name.StartsWith('FCST'));
    end;

    /// <summary>Raises the matching error when the name is not writable, or the budget is missing or blocked.</summary>
    procedure AssertWritable(BudgetName: Code[10])
    var
        GLBudgetName: Record "G/L Budget Name";
        Name: Text;
    begin
        Name := UpperCase(BudgetName);
        if Name = '' then
            Error(BlankErr);
        if Name.EndsWith('-ORIG') then
            Error(OrigRefusedErr, BudgetName);
        if not IsWritable(BudgetName) then
            Error(NotWhitelistedErr, BudgetName);
        // The table relation on "Budget Name" already refuses an unknown budget; this gives the app a clearer message.
        GLBudgetName.Get(BudgetName);
        if GLBudgetName.Blocked then
            Error(BlockedErr, BudgetName);
    end;
}
