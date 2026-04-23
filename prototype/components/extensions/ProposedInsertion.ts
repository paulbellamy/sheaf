import { makeProposedMark } from "./makeProposedMark";

const { mark, findRange } = makeProposedMark({
  name: "proposedInsertion",
  tag: "ins",
  className: "proposed-insertion",
  inclusive: true,
});

export const ProposedInsertion = mark;
export const findInsertionRange = findRange;
