// THE CLAIM SENDER POLICY (#18): the half is revealed by the sender, so the package sends a claim only from the
// claimer's own wallet. The rule is pure and is checked here without a chain.
import { claimSenderVerdict } from "../src/actions.mjs";

export const claimSenderCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const same = claimSenderVerdict({ sender: "0xAbC0000000000000000000000000000000000001", claimer: "0xabc0000000000000000000000000000000000001" });
  check(same.ok === true, "the same address in different case was refused");
  const other = claimSenderVerdict({ sender: "0x1111111111111111111111111111111111111111", claimer: "0x2222222222222222222222222222222222222222" });
  check(other.ok === false && other.field === "wallet" && other.why === "not-the-claimer", "a third-party sender was accepted");
  const noClaimer = claimSenderVerdict({ sender: "0x1111111111111111111111111111111111111111" });
  check(noClaimer.ok === false && noClaimer.field === "claimer", "a claim without a claimer was accepted");
  const noSender = claimSenderVerdict({ claimer: "0x1111111111111111111111111111111111111111" });
  check(noSender.ok === false && noSender.field === "wallet.address", "a wallet without an address was accepted");

  notes.push("a claim is sent only from the claimer's own wallet; a third-party sender is named");
  return { note: "the claim sender policy refuses a foreign wallet and a missing claimer", problems, notes };
};
