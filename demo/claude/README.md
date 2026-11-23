# One agent, one shop, one person in control

**An illustrated walkthrough of the Accountable Agents Framework reference implementation, in nine scenes.**

A person finds the pilot, enrolls with a passkey and hands one message to their agent. The agent gets an ID. A shop checks it and asks for more when the stakes rise. A person approves one exact order with a passkey, takes a permission back, and then switches the agent off. Each scene shows what really happened on screen.

<table><tr><td align="center" width="25%"><h3><a href="aaf-illustrated-walkthrough.pdf">PDF</a></h3>29 pages, opens in the browser</td><td align="center" width="25%"><h3><a href="aaf-illustrated-walkthrough.docx">Word</a></h3>Editable document</td><td align="center" width="25%"><h3><a href="aaf-illustrated-walkthrough.pptx">PowerPoint</a></h3>53 slides with speaker notes<br><a href="aaf-illustrated-walkthrough-slides.pdf">preview the slides as PDF</a></td><td align="center" width="25%"><h3><a href="WALKTHROUGH.md">Read it here</a></h3>The same walkthrough in Markdown</td></tr></table>

<img src="images/14-approve.png" alt="Trusted screen: Approve this one action, showing the shop that asked, the agent that asked, the item, quantity and total of 480, that there is no charge, the time to approve by, and a note that this approves exactly this action, once." width="640">

*Scene 6. The person approves one exact order with a passkey. The trusted screen shows the order as the Shop signed it.*

## The story in nine scenes

| | Scene | In one line | Answer |
|---|---|---|---|
| 1 | [The front door: one message to give your agent](WALKTHROUGH.md#scene-1-the-front-door-one-message-to-give-your-agent) | I can see what this is, what my agent will be told, and what I will have to do, before I give anything away. | Ready |
| 2 | [An invitation, a passkey, and Riley is the principal](WALKTHROUGH.md#scene-2-an-invitation-a-passkey-and-riley-is-the-principal) | I proved I control a mailbox and I hold a passkey. The Directory claims nothing more about me than that. | Enrolled |
| 3 | [The agent asks to be registered](WALKTHROUGH.md#scene-3-the-agent-asks-to-be-registered) | My agent can ask to act for me. Only I can make it mine, and I set its limit when I do. | Registered |
| 4 | [The Shop checks a fresh ID, nothing more](WALKTHROUGH.md#scene-4-the-shop-checks-a-fresh-id-nothing-more) | The Shop verified the ID, not me. A quote needs nothing more. | Granted |
| 5 | [A bigger order: the Shop asks for more](WALKTHROUGH.md#scene-5-a-bigger-order-the-shop-asks-for-more) | My standing permission covers the amount. Above fifty dollars, the Shop still wants my yes on the exact order. | Asked for more |
| 6 | [One exact order, approved with a passkey](WALKTHROUGH.md#scene-6-one-exact-order-approved-with-a-passkey) | I approved one order, for this item at this price. Nothing else can ride on that approval. | Granted |
| 7 | [A smaller lever: take back one permission](WALKTHROUGH.md#scene-7-a-smaller-lever-take-back-one-permission) | I took back the permission to order. My agent can still ask for a price, and it can no longer buy. | Withdrawn |
| 8 | [Revocation: two different refusals](WALKTHROUGH.md#scene-8-revocation-two-different-refusals) | After I revoke, my agent gets no new ID, and the Shop stops accepting the ones it had. | Revoked |
| 9 | [Accountability without exposure](WALKTHROUGH.md#scene-9-accountability-without-exposure) | The Shop never learned who I was. If someone with authority must know, the Directory can say, for that one receipt, and it tells me. | Released |

## What the demo shows

- **Setup starts from one message.** The Directory's first screen gives a visitor a short message to hand to their agent, the instructions the agent reads, and a guide for the person. Enrollment is by invitation and a passkey.
- **The Shop checks an ID, not a person.** A quote needs only a fresh, single-use ID from a Directory the Shop trusts. The Shop's own screen lists what it did not learn, and the person's identity is on that list.
- **Authority is a separate claim.** For an order the Shop asks for more: proof that the person allowed this kind of spending, vouched for by the Directory.
- **Approval is exact.** Above USD 50 the Shop wants the person's passkey approval of that one order. The approval names the item and the total, and it cannot be reused.
- **There are two levers.** Withdrawing one permission stops orders while a quote still works. Revoking the agent blocks fresh quotes and orders that require an ID. The catalog stays public.
- **Revocation shows up in two places.** The Shop rejects an ID it was given before the revocation, and the Directory refuses to issue a new one. The walkthrough shows both and keeps them apart.
- **Accountability arrives without exposure.** The Shop holds a signed receipt and never an identity. A Directory operator can connect the two for one case, and the person is told.

| The Shop checks a fresh ID | The Shop rejects it after revocation |
|---|---|
| ![Shop front desk: most recent request granted, a quote for cards-500 at 38 US dollars, with what the agent showed, what the shop checked and what it did not learn.](images/11-quote.png) | ![Shop front desk: most recent request denied, a check of an ID; the shop said no because the ID has been revoked.](images/21-id-rejected.png) |

## The demo's two designs

The Directory and the Shop each come in two page designs, chosen from the **Design** menu. **Story** tells the lifecycle as a guided sequence and is the design used in this walkthrough. **Console** shows the same data as a dense working view. A design can only display data and ask for an action. Every approval happens on a trusted screen that the page itself draws.

| | Story | Console |
|---|---|---|
| **Directory** | ![The Directory in the Story design, as a signed-out visitor sees it](images/design-directory-story.png) | ![The Directory in the Console design, as a signed-out visitor sees it](images/design-directory-console.png) |
| **Shop** | ![The Shop in the Story design, with sample data](images/design-shop-story.png) | ![The Shop in the Console design, with sample data](images/design-shop-console.png) |

Open each design on the hosted pilot. No sign-in is needed to look around. Since version 0.2.0 visitors see live records only: the Directory is shown above as a signed-out visitor sees it, and the sample data in the Shop screenshots is available to anyone running the pilot locally. On the hosted Directory, samples are reserved for the signed-in operator.

| | Story | Console |
|---|---|---|
| **Directory** | [Open Story](https://aaf-dir.civics.com/?skin=Story) | [Open Console](https://aaf-dir.civics.com/?skin=Console) |
| **Shop** | [Open Story](https://aaf-shop.civics.com/?skin=Story) | [Open Console](https://aaf-shop.civics.com/?skin=Console) |

The designs are plain files in the repository: [Directory Story](../../skins/directory/Story.tsx), [Directory Console](../../skins/directory/Console.tsx), [Shop Story](../../skins/shop/Story.tsx) and [Shop Console](../../skins/shop/Console.tsx). The sample data they show is in [`datasets/`](../../datasets/).

## About this rehearsal

Local rehearsal with stand-in passkeys · 23 November 2026 · source commit 445d641.

The screenshots come from an actual run of the reference implementation on a local copy, with its own ports and disposable data. Three stand-ins were used and are labelled on screen: Chrome's virtual authenticator approved each passkey prompt, the invitation link was shown on screen instead of emailed, and the identity is synthetic. Agent requests and results are the `aaf-agent` tool's own output. Every order is fictional.

The walkthrough ends with [what the rehearsal showed and what it did not](WALKTHROUGH.md#what-this-rehearsal-showed-and-what-it-did-not).

The [Codex walkthrough](../codex/WALKTHROUGH.md) also shows a declined order, a resumed approval, and reconnecting with a new registration after revocation.

## Files in this folder

| File | What it is |
|---|---|
| [`aaf-illustrated-walkthrough.pdf`](aaf-illustrated-walkthrough.pdf) | The full walkthrough, laid out for reading and printing |
| [`aaf-illustrated-walkthrough.docx`](aaf-illustrated-walkthrough.docx) | The same content as an editable Word document |
| [`aaf-illustrated-walkthrough.pptx`](aaf-illustrated-walkthrough.pptx) | The slide deck, with narration and what to notice in the speaker notes |
| [`aaf-illustrated-walkthrough-slides.pdf`](aaf-illustrated-walkthrough-slides.pdf) | The slides as a PDF, for previewing in the browser |
| [`WALKTHROUGH.md`](WALKTHROUGH.md) | The full walkthrough in Markdown |
| [`images/`](images/) | The screenshots and diagrams used above |

Companion to *The Accountable Agents Framework (AAF): A Blueprint for AI Agent IDs*. Back to the [repository README](../../README.md).
