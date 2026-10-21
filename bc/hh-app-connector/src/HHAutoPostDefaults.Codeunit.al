/// <summary>
/// BC change 6 (approved October 20, 2026): rule-posted entries carry source code HHAUTO and reason code AUTOPOST so they
/// are distinguishable from Cade's own postings in every report and in the Change Log. The API v2.0 journalLines
/// resource exposes neither field, and the standard SetUpNewLine only runs in the client, so this subscriber stamps
/// both on every line inserted into the HHAPP/AUTOPOST batch, whichever route inserted it.
///
/// The codes themselves are master data made by hand in the runbook (bc/runbook-additions.md, change 6); this
/// subscriber only fills them in when they exist, so publishing the extension before the codes are created is harmless.
/// </summary>
codeunit 72101 "HH AutoPost Defaults"
{
    var
        HHAppTemplateTok: Label 'HHAPP', Locked = true;
        AutoPostBatchTok: Label 'AUTOPOST', Locked = true;
        AutoSourceCodeTok: Label 'HHAUTO', Locked = true;
        AutoReasonCodeTok: Label 'AUTOPOST', Locked = true;

    [EventSubscriber(ObjectType::Table, Database::"Gen. Journal Line", 'OnBeforeInsertEvent', '', false, false)]
    local procedure OnBeforeInsertGenJournalLine(var Rec: Record "Gen. Journal Line"; RunTrigger: Boolean)
    begin
        if Rec.IsTemporary() then
            exit;
        if (Rec."Journal Template Name" <> HHAppTemplateTok) or (Rec."Journal Batch Name" <> AutoPostBatchTok) then
            exit;
        StampAutoPostCodes(Rec);
    end;

    [EventSubscriber(ObjectType::Table, Database::"Gen. Journal Line", 'OnBeforeModifyEvent', '', false, false)]
    local procedure OnBeforeModifyGenJournalLine(var Rec: Record "Gen. Journal Line"; var xRec: Record "Gen. Journal Line"; RunTrigger: Boolean)
    begin
        if Rec.IsTemporary() then
            exit;
        if (Rec."Journal Template Name" <> HHAppTemplateTok) or (Rec."Journal Batch Name" <> AutoPostBatchTok) then
            exit;
        StampAutoPostCodes(Rec);
    end;

    local procedure StampAutoPostCodes(var GenJnlLine: Record "Gen. Journal Line")
    var
        SourceCode: Record "Source Code";
        ReasonCode: Record "Reason Code";
    begin
        if SourceCode.Get(AutoSourceCodeTok) then
            GenJnlLine."Source Code" := SourceCode.Code;
        if ReasonCode.Get(AutoReasonCodeTok) then
            GenJnlLine."Reason Code" := ReasonCode.Code;
    end;

    // VERIFY on the sandbox after the first AUTOPOST post: the G/L entry shows Source Code HHAUTO. Codeunit 12
    // "Gen. Jnl.-Post Line" copies the line's Source Code to the entry; if codeunit 13 "Gen. Jnl.-Post Batch" turns
    // out to overwrite it from the template's Source Code, the fallback is a second journal template HHAUTO (Source
    // Code HHAUTO) holding the AUTOPOST batch, and the adapter's journalTemplate for AUTOPOST changes to HHAUTO.
}
