# Liar's Dice - the table

Chinese-variant Liar's Dice (大话骰) in the browser, against a characterful
AI. No install, no account, nothing leaves your browser. Play it at **https://chongjiazhen.github.io/liars-dice-table/**

This is a beta for playtesting the AI: how the rivals bid, when they call, how
fast a table thins out. Two formats - the **Bar** (drinks, a hidden collapse
point per seat) and the **Ship** (Perudo-style dice loss) - up to six seats,
nine house rules you can toggle (each format opens on its own set; the ones
that travel can be brought to the other table), and an **IOU** mode on the
ship where one rival is the house and you hold markers against it.

## Rules in brief

Everyone rolls five dice under a cup and sees only their own. Bids go round the
table as `quantity × face` over **all** dice on the table, and each bid must
out-rank the last. Challenge instead of raising and every cup opens: if the
bid was good the challenger loses the hand, otherwise the bidder does.

- **Bar (大话骰).** 1s are wild unless a bid is made in *ones literal* mode. A
  five-of-a-kind at reveal counts as 7 (natural) or 6 (wild-assisted). The
  loser drinks; each seat has a hidden collapse point, and the last seat still
  upright takes the table. Dice are never lost.
- **Ship (Dudo).** 1s are always wild, a hand may open at any quantity, no
  five-of-a-kind bonus. The loser of a hand loses a die; last cup standing wins.
- **IOU mode (ship).** Cove is the house; you, Sol and Lark each hold markers
  against it. Beat the house in a hand and shred one marker; lose to it and
  take one on, two if it knocks you out; knock the house out and everyone
  still holding markers shreds fifteen. The crew leans on whoever is deepest
  in. Markers carry over between matches in this browser.

## What the page does

- **You sit at seat 0.** On your turn the legal raises are buttons; any legal
  quantity can also be typed. Challenge calls the standing bid.
- **The table remembers you.** The rivals keep a running read of how often
  you bluff and how thin you call. It is stored in your browser only, seeds
  the next match, and is shown as one line at the top. *Forget me* clears it.
- **A record** per rival and your IOU markers persist the same way.
- **Copy match log** puts the whole hand history, the seed and the build on
  your clipboard - that is what a report needs.

## What it is not

- It is the engine's **measurement table** - the match loop every difficulty
  number was tuned on - with a human in one seat. Rivals go by short handles.
- In this cut the AI still takes a few decisions **for** you: surrender or
  counter-kill in a duel, an exact call, a chain-kill sweep, an out-of-turn
  challenge. The page says so under the table.
- No save beyond the read, the record and the markers. No sound. One column.

## Reporting

[Open an issue](https://github.com/chongjiazhen/liars-dice-table/issues/new/choose)
and paste the match log. One problem per issue. Balance
impressions ("Wren never loses", "the bar empties in five hands") are as
welcome as bugs - rough counts over a few matches beat one exact number.

## Licence

The page (`web/*.html`, `*.js`, `*.css`) is MIT - see `LICENSE`. The compiled
table `web/dist/table.wasm` and its glue `web/dist/table.js` ship under the
grant in `web/dist/LICENSE`, with third-party notices beside it.
