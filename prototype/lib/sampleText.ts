export const sampleManuscript = `
<h1>On Living Specifications</h1>
<p class="subtitle">A note toward the design of a documentation substrate for the AI era.</p>
<section>
<p><span class="newthought">Documents are</span> the primary artifact of software work; code is a compile target. The tools we use to coordinate on documents treat them as either versioned-but-inert text files in git, or multiplayer-but-ephemeral blobs in Notion. Neither treats documents as what they actually are: long-lived, forkable, commentable, agent-editable specifications.</p>
<p>A living specification spends ninety percent of its life in re-drafting and review, not in greenfield authoring. The user experience should optimize for that. The dominant metaphor ought to be an editor working on a manuscript &mdash; crossing things out, inserting replacements, scribbling in the margins &mdash; not a word processor, and certainly not a pull-request queue.</p>
<h2>The Non-Linearity Problem</h2>
<p>Knowledge work is non-linear. A living specification is a node in a graph of other specifications. Today we serialize that graph by hand with hyperlinks, and it rots. Links go stale silently. Copies drift silently. Readers chase references across tabs and return with half their attention intact.</p>
<p>Taking Ted Nelson seriously would mean transclusion, bi-directional visibility, parallel texts, and trails. The document exposes its own connections without forcing the reader to context-switch to see them. The doc is the map is the territory.</p>
<h2>The Review Problem</h2>
<p>Existing review tools were shaped by code, not prose. A pull request is a diff and a conversation about the diff, but the conversation lives apart from the work. Reviewers toggle between file view, comment view, and discussion view. Authors answer the same question three times in three threads because the tool cannot see that it is the same question.</p>
<p>The reviewer of a manuscript does not toggle between views. She marks up the page. Her marginal notes sit next to the prose they address. The proposed change is legible in situ, alongside the text it replaces. There is one surface, and the surface is the page.</p>
</section>
`.trim();
