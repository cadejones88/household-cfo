/**
 * The receipt card after a snap (H3): the photo, "Saved on your phone — not synced yet" while offline,
 * "Reading…" after upload, then merchant, total, date and the split it proposes, with Done. Tap three: Done.
 */
import { Image, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useReceipt, useAnswerQuestion } from "@/api/hooks";
import { categoryName } from "@/model/categories";
import { fmtShort, money } from "@/model/format";
import { receiptFileUri } from "@/receipts/fileStore";
import { useReceiptQueue } from "@/receipts/ReceiptQueueProvider";
import { useTheme } from "@/ui/ThemeProvider";
import { useToast } from "@/ui/Toast";
import { SheetScreen } from "@/ui/Screen";
import { Button, ButtonRow, Card, Eyebrow, H2, KV, Note, Pill } from "@/ui/primitives";

export default function ReceiptCard(): React.JSX.Element {
  const { clientId } = useLocalSearchParams<{ clientId: string }>();
  const router = useRouter();
  const { p } = useTheme();
  const queue = useReceiptQueue();
  const { show: toast } = useToast();
  const item = queue.item(clientId ?? "");
  const receiptId = item?.receiptId;
  const detail = useReceipt(receiptId, { pollWhileReading: true });
  const answer = useAnswerQuestion();
  const r = detail.data;
  const read = r?.ocrStatus === "read";
  const failed = item?.status === "error" || r?.ocrStatus === "failed";
  const done = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const eyebrow = !item
    ? "Receipt"
    : failed
      ? "Couldn't read this one"
      : item.status === "queued" || item.status === "uploading"
        ? queue.online
          ? "Sending…"
          : "Saved on your phone — not synced yet"
        : read
          ? r?.matchedTransactionId
            ? "Matched to a charge"
            : "Recorded"
          : "Reading your receipt…";
  const title = r?.merchant ?? (read ? "Receipt" : "Your receipt");
  const splitLines = r?.split?.lines ?? [];
  const category = splitLines.length === 1 ? categoryName(splitLines[0]?.categoryId) : splitLines.length > 1 ? "Split" : r?.lines?.[0]?.suggestedCategoryId ? categoryName(r.lines[0].suggestedCategoryId) : undefined;
  const txId = r?.matchedTransactionId ?? r?.transaction?.id;

  const confirm = async () => {
    if (!txId) return;
    try {
      await answer.mutateAsync({ id: `tx:${txId}`, input: { optionId: "confirm" } });
      toast("Recorded. Thanks!");
      done();
    } catch {
      toast("Recorded. Nothing more to confirm.");
      done();
    }
  };

  return (
    <SheetScreen
      title={title}
      eyebrow={eyebrow}
      testID="receipt-card"
      footer={
        failed ? (
          <ButtonRow>
            <Button title="Snap it again" kind="primary" style={{ flex: 1 }} onPress={() => router.replace("/snap")} />
            <Button title="Remove" style={{ flex: 1 }} onPress={() => void (item && queue.remove(item.clientId).then(done))} />
          </ButtonRow>
        ) : r?.split?.needsConfirmation && txId ? (
          <ButtonRow>
            <Button title="Yes, looks right" kind="primary" style={{ flex: 1 }} disabled={answer.isPending} onPress={() => void confirm()} testID="receipt-confirm" />
            <Button title="Change" style={{ flex: 1 }} onPress={() => router.replace({ pathname: "/wrong/[id]", params: { id: txId } })} />
          </ButtonRow>
        ) : (
          <Button title="Done" kind="primary" block onPress={done} testID="receipt-done" />
        )
      }
    >
      {item && <Image source={{ uri: receiptFileUri(item.relativePath) }} accessibilityLabel="Your receipt photo" resizeMode="cover" style={{ width: "100%", aspectRatio: 3 / 4, maxHeight: 320, borderRadius: 12, backgroundColor: p.surface2 }} />}
      {!item && <Note>This receipt isn't on this phone any more.</Note>}

      {read && r && (
        <Card style={{ gap: 0 }}>
          <KV first label="Merchant" value={r.merchant ?? "—"} />
          <KV label="Total" value={r.totalCents !== undefined ? money(r.totalCents) : "—"} />
          <KV label="Date" value={r.receiptDate ? fmtShort(r.receiptDate) : "—"} />
          <KV label="Category" value={category ?? "Needs a category"} />
        </Card>
      )}

      {read && splitLines.length > 1 && (
        <Card style={{ gap: 0 }}>
          <Eyebrow style={{ paddingBottom: 6 }}>Split from the receipt</Eyebrow>
          {splitLines.map((s, i) => (
            <KV key={s.lineNo} first={i === 0} label={categoryName(s.categoryId)} value={money(Math.abs(s.amountCents))} />
          ))}
          {r?.split?.needsConfirmation && <Note style={{ paddingTop: 8 }}>Look right? One tap keeps the budget honest.</Note>}
        </Card>
      )}

      {!read && !failed && item && (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <H2>{item.status === "synced" || item.status === "duplicate" ? "Reading the lines…" : queue.online ? "Sending to Homestead…" : "Saved on your phone"}</H2>
            <Pill status={item.status === "synced" || item.status === "duplicate" ? "good" : "neutral"} label={item.status === "synced" || item.status === "duplicate" ? "Synced" : "Not synced yet"} />
          </View>
          <Note>{queue.online ? "We'll match it to the bank when the charge shows up, usually in a day or two." : "We'll send it and match it to the bank as soon as you're back online."}</Note>
          {item.attempts > 0 && item.status === "queued" && <Note>Trying again shortly ({item.attempts} {item.attempts === 1 ? "try" : "tries"} so far).</Note>}
        </Card>
      )}

      {failed && (
        <Card>
          <H2>This photo couldn't be read</H2>
          <Note>{item?.lastError ?? "Try again in better light, with the whole receipt in the frame."}</Note>
        </Card>
      )}

      {read && <Note>We'll match it to the bank when the charge shows up, usually in a day or two.</Note>}
    </SheetScreen>
  );
}
