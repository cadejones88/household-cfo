/// <summary>
/// Temporary buffer behind the hhJournalLineChecks API page. One row per general journal line or G/L entry that carries the
/// External Document No. the caller filtered on. Never persisted: the page fills it per request (SourceTableTemporary).
/// </summary>
table 50100 "HH Doc Check Row"
{
    Caption = 'HH Doc Check Row';
    DataClassification = SystemMetadata;
    TableType = Temporary;

    fields
    {
        field(1; "Row No."; Integer)
        {
            Caption = 'Row No.';
            DataClassification = SystemMetadata;
        }
        field(2; "External Document No."; Code[35])
        {
            Caption = 'External Document No.';
            DataClassification = CustomerContent;
        }
        field(3; Source; Enum "HH Doc Source")
        {
            Caption = 'Source';
            DataClassification = SystemMetadata;
        }
        field(10; "Journal Template Name"; Code[10])
        {
            Caption = 'Journal Template Name';
            DataClassification = CustomerContent;
        }
        field(11; "Journal Batch Name"; Code[10])
        {
            Caption = 'Journal Batch Name';
            DataClassification = CustomerContent;
        }
        field(12; "Line No."; Integer)
        {
            Caption = 'Line No.';
            DataClassification = SystemMetadata;
        }
        field(13; "Line SystemId"; Guid)
        {
            Caption = 'Line SystemId';
            DataClassification = SystemMetadata;
        }
        field(20; "Entry No."; Integer)
        {
            Caption = 'Entry No.';
            DataClassification = SystemMetadata;
        }
        field(21; "Document No."; Code[20])
        {
            Caption = 'Document No.';
            DataClassification = CustomerContent;
        }
        field(22; "Posting Date"; Date)
        {
            Caption = 'Posting Date';
            DataClassification = CustomerContent;
        }
        field(23; "Account Type"; Enum "Gen. Journal Account Type")
        {
            Caption = 'Account Type';
            DataClassification = CustomerContent;
        }
        field(24; "Account No."; Code[20])
        {
            Caption = 'Account No.';
            DataClassification = CustomerContent;
        }
        field(25; Amount; Decimal)
        {
            Caption = 'Amount';
            DataClassification = CustomerContent;
            AutoFormatType = 1;
        }
        field(26; "Dimension Set ID"; Integer)
        {
            Caption = 'Dimension Set ID';
            DataClassification = SystemMetadata;
        }
        field(27; "Source Code"; Code[10])
        {
            Caption = 'Source Code';
            DataClassification = CustomerContent;
        }
        field(28; "Reason Code"; Code[10])
        {
            Caption = 'Reason Code';
            DataClassification = CustomerContent;
        }
    }

    keys
    {
        key(PK; "Row No.")
        {
            Clustered = true;
        }
        key(ExtDoc; "External Document No.", Source)
        {
        }
    }
}
