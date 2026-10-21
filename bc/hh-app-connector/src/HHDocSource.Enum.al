/// <summary>
/// Where an External Document No. was found by hhJournalLineChecks: a draft line in a general journal, or a posted G/L entry.
/// The value names are what the API serializes (the adapter compares against "Journal" and "Ledger").
/// </summary>
enum 72100 "HH Doc Source"
{
    Extensible = false;

    value(0; Journal)
    {
        Caption = 'Journal';
    }
    value(1; Ledger)
    {
        Caption = 'Ledger';
    }
}
