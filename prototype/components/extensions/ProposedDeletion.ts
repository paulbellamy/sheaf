import { makeProposedMark } from "./makeProposedMark";

const { mark, findRange } = makeProposedMark({
  name: "proposedDeletion",
  tag: "del",
  className: "proposed-deletion",
});

export const ProposedDeletion = mark;
export const findThreadRange = findRange;
