/**
 * Mark as business (V9, D5): almost everything is personal, so this is the exception. CTJ (Cade's firm) or
 * Lash (Vanessa's business), or keep it personal. Cade sees business items in his list.
 */
import { useLocalSearchParams, useRouter } from "expo-router";
import type { BusinessFlag } from "@homestead/shared";
import { useSetBusinessFlag, useTransaction } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { businessSeenBy } from "@/model/people";
import { useToast } from "@/ui/Toast";
import { SheetScreen } from "@/ui/Screen";
import { Button, ButtonRow, Note, Sub } from "@/ui/primitives";

export default function Business(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const auth = useAuth();
  const { show: toast } = useToast();
  const tx = useTransaction(id);
  const set = useSetBusinessFlag();
  const current = tx.data?.businessFlag ?? "none";

  const choose = async (flag: BusinessFlag) => {
    if (!id) return;
    try {
      await set.mutateAsync({ id, flag });
      toast(flag === "none" ? "Kept personal" : `Marked as ${flag === "ctj" ? "CTJ" : "Lash"} business · ${businessSeenBy(auth.member?.displayName)}`);
      router.back();
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : "That didn't go through. Try again.");
    }
  };

  return (
    <SheetScreen title="Mark as business" testID="business-sheet">
      <Sub>Almost everything is personal, so this is the exception. Business items stay out of household spending.</Sub>
      <ButtonRow>
        <Button title="Cade's firm (CTJ)" kind={current === "ctj" ? "default" : "primary"} style={{ flex: 1 }} disabled={set.isPending} onPress={() => void choose("ctj")} testID="business-ctj" />
        <Button title="Lash business" kind={current === "lash" ? "default" : "primary"} style={{ flex: 1 }} disabled={set.isPending} onPress={() => void choose("lash")} testID="business-lash" />
      </ButtonRow>
      <Button title="Keep it personal" block disabled={set.isPending} onPress={() => void choose("none")} />
      <Note>CTJ on a household card means CTJ owes the household for it. Lash goes to Vanessa's business accounts.</Note>
    </SheetScreen>
  );
}
