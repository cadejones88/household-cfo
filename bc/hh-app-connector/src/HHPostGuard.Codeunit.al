/// <summary>
/// BC change 6b (posting right for HHAPP/AUTOPOST; approved with auto-post rules R2, R3 and R7, Phase 3 spec decision 4,
/// and Gate 4 on 10/21/2026): the app may post one batch, HHAPP/AUTOPOST, and nothing else.
///
/// HH-APP gives the posting codeunits the indirect rights they need, and those rights are not limited to one batch: a
/// permission set cannot filter by template or batch (an AL permission set carries no security filters, and a filter on
/// a user-defined set does not narrow a right another assigned set grants without one). So the limit is enforced here.
/// Any posting started from a web-service session (API, OData, SOAP; the only way the app reaches BC) is refused
/// unless it posts HHAPP/AUTOPOST. FEEDS, RECEIPTS and every other journal stay Cade's to post in the BC client, which
/// this codeunit never affects. Gen. Jnl.-Post Batch runs for every general journal posting, whichever page or action
/// starts it, so subscribing there covers the API's journals post action and any other route.
/// </summary>
codeunit 72102 "HH Post Guard"
{
    var
        HHAppTemplateTok: Label 'HHAPP', Locked = true;
        AutoPostBatchTok: Label 'AUTOPOST', Locked = true;
        NotThroughApiErr: Label 'Journal %1/%2 cannot be posted through the API in this company. Homestead posts only HHAPP/AUTOPOST; post %1/%2 in Business Central.', Comment = '%1 = journal template name, %2 = journal batch name';

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Gen. Jnl.-Post Batch", 'OnBeforeCode', '', false, false)]
    local procedure RefuseOtherBatchesFromWebServices(var GenJournalLine: Record "Gen. Journal Line")
    begin
        if not IsWebServiceSession() then
            exit;
        if IsAllowed(GenJournalLine."Journal Template Name", GenJournalLine."Journal Batch Name") then
            exit;
        Error(NotThroughApiErr, GenJournalLine."Journal Template Name", GenJournalLine."Journal Batch Name");
    end;

    /// <summary>The one journal a web-service session may post.</summary>
    procedure IsAllowed(TemplateName: Code[10]; BatchName: Code[10]): Boolean
    begin
        exit((TemplateName = HHAppTemplateTok) and (BatchName = AutoPostBatchTok));
    end;

    local procedure IsWebServiceSession(): Boolean
    begin
        exit(Session.CurrentClientType() in [ClientType::Api, ClientType::ODataV4, ClientType::OData, ClientType::SOAP]);
    end;
}
