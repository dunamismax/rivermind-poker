# No-limit hold’em rules

This is the rules specification for RiverMind Poker’s main game: no-limit Texas hold’em with a 52-card deck at tables of 2 to 9 seats, played for play chips only (D-1). The engine in `rivermind/engine` (Phase 2), the table server (Phase 3) and the bots (Phase 5) implement exactly these rules. Each rule has a worked example, and each example becomes a fixture test.

Where card rooms differ, [Choices](#choices) lists the option chosen and why. The rules otherwise follow common tournament and online practice (the Poker TDA rules), simplified where a computer dealer makes a rule unnecessary.

## Conventions

- **Seats** are numbered 0 to 8 clockwise, written S0 to S8. “Left of” means clockwise from.
- **Chips** are whole numbers. There are no fractional chips and no rake.
- A player’s **contribution** is everything they have put in during the hand: antes, blinds, bets and calls. Their **street bet** is what they have put in on the current betting round, counting blinds pre-flop but not antes.
- **Bet and raise amounts are totals for the street.** “Raise to 300” means the player’s street bet becomes 300. The **increment** of a bet or raise is how much it raises the current bet.
- Examples use blinds of 50 and 100 and stacks of 10,000 unless they say otherwise.

## 1. Deck and dealing

1.1. Each hand uses one standard 52-card deck, shuffled before the hand. Live tables shuffle with the operating system’s cryptographic randomness (`crypto.randomInt` in the Node table server; `secrets.SystemRandom` in the Python one kept for a rollback; D-8). The engine never shuffles by itself: the caller supplies either a deck order or a random generator, so tests, training and evaluation can replay deals exactly.

1.2. Cards are dealt from the top of the deck in order. Each player dealt in receives two hole cards, one at a time, starting with the player left of the button and going clockwise, twice round. Heads-up this means the big blind gets the first card.

1.3. Before the flop, the turn and the river, one card is burned (dealt face down to no one). Then the flop is three cards, the turn one card and the river one card.

1.4. With *n* players dealt in, numbered *i* = 0 to *n* − 1 from the player left of the button, positions in the deck order *d* are used as follows:

| Cards | Deck positions |
| --- | --- |
| First hole card of player *i* | *d*[*i*] |
| Second hole card of player *i* | *d*[*n* + *i*] |
| Burn, flop | *d*[2*n*], then *d*[2*n* + 1] to *d*[2*n* + 3] |
| Burn, turn | *d*[2*n* + 4], then *d*[2*n* + 5] |
| Burn, river | *d*[2*n* + 6], then *d*[2*n* + 7] |

Cards for streets that are never reached are not dealt. A hand uses at most 2*n* + 8 cards, which is 26 at nine seats.

**Example.** Six players, S0 to S5, with the button on S2. Dealing starts at S3, so S3 is player 0 and S2 is player 5. S3 gets *d*[0] and *d*[6], S4 gets *d*[1] and *d*[7], and S2 gets *d*[5] and *d*[11]. *d*[12] is burned, the flop is *d*[13], *d*[14] and *d*[15], *d*[16] is burned, the turn is *d*[17], *d*[18] is burned and the river is *d*[19].

## 2. Seats and players dealt in

2.1. A table has 2 to 9 seats. A hand starts when at least two seated players are **dealt in**: seated, not sitting out and holding at least one chip. With exactly two players dealt in, the heads-up rules in [section 4](#4-heads-up) apply, whatever the table’s seat count.

2.2. A player who takes a seat, or comes back from sitting out, is dealt in from the next hand that starts. They post only the blinds and antes their position requires (see [Choices](#choices)).

2.3. A player can leave or sit out between hands. A player who leaves during a hand forfeits it: they fold when their turn comes, and their chips already in the pot stay there.

2.4. A seat can be **held** for a player while they buy in, for 60 seconds; only that player can sit in it. A player who wants a seat where bots sit can take a bot's: between hands the bot leaves at once, and during a hand it plays the hand out and leaves when the hand ends, when the 60 seconds start. When no seat is empty or held by a bot, a player can join the table's **waitlist**. A seat that comes free is held for the first player in line, and passes to the next if they do not sit in time. At a table with bots, a free seat nobody is waiting for goes back to a bot. Holding a seat or waiting changes nothing at the table: a player who sits is dealt in from the next hand (rule 2.2).

**Example.** A nine-seat table has players in S1 and S6 only, so the hand is played heads-up. If S6 sits out, no hand starts until another player is dealt in. When a third player sits down in S3 during a hand, they are dealt in from the next hand.

**Example (held seats).** A six-seat table has one person, in S0, and five bots. During a hand, a second person asks for a seat: the bot in S1 plays the hand out, leaves when it ends, and S1 is held for the newcomer for 60 seconds. At a two-seat table of two people, a third joins the waitlist; when one of the two leaves, their seat is held for the third when that hand ends.

## 3. Blinds and antes

3.1. Before the cards are dealt, the player left of the button posts the **small blind** and the next player clockwise posts the **big blind**. Heads-up is different; see [section 4](#4-heads-up).

3.2. A table may have an **ante**, which is zero by default. Each player dealt in posts the ante before the blinds. Antes go into the pot but are not street bets: they do not count toward calling or raising.

3.3. A player who cannot cover a blind or ante posts all their chips and is all-in. A short small blind changes nothing else. A short big blind does not lower the price of the hand: the current bet pre-flop is still one full big blind, and the minimum raise is still to two big blinds.

3.4. Pre-flop the blinds are live: they count toward the blind’s street bet, and the big blind may still raise when every other player has only called (the **option**).

**Example (antes).** Six players, ante 10. The antes put 60 in the pot. S3 posts the small blind of 50 and S4 the big blind of 100, so the pot is 210 before anyone acts. S5 acts first and must call 100 or raise to at least 200.

**Example (short big blind).** S4 has only 60 and posts it all-in as the big blind. The current bet is still 100: S5 must put in 100 to call, and the minimum raise is to 200. If S5 and S3 both call, S4 is eligible for 60 from each player; the other chips form a side pot (section 9).

**Example (short ante).** Ante 10, and S1 has 5 chips. S1 posts 5 as the ante and is all-in before the cards are dealt. S1 can win at most 5 from each other player.

## 4. Heads-up

4.1. With two players dealt in, the button posts the small blind and the other player posts the big blind.

4.2. The button acts first before the flop and last on every later street.

4.3. Following rule 1.2, the big blind gets the first card.

**Example.** S0 is the button and S5 the big blind. S0 posts 50 and S5 posts 100. Cards go S5, S0, S5, S0. Before the flop S0 acts first: fold, call 50 more, or raise to at least 200. On the flop, turn and river S5 acts first.

## 5. The button

5.1. For a table’s first hand the button goes to a random player dealt in, drawn from the table’s generator. Tests set it directly.

5.2. After each hand the button moves to the first player dealt in for the new hand clockwise from the previous button seat, whether or not that seat is still occupied. Then the small blind is the next player dealt in clockwise from the button and the big blind the one after. This is a **moving button**: the button, small blind and big blind are always three different players dealt in, or two players heads-up.

5.3. Going from three or more players to two, or from two to more, needs no special case: rule 5.2 picks the button and section 4 or rule 3.1 the blinds.

**Example (seats emptying).** Players in S0 to S5 with the button on S1. Next hand the button is S2, the small blind S3 and the big blind S4. If S2 has left before that hand, the button goes to S3 instead, the small blind is S4 and the big blind S5. If instead S4 is sitting out, the button is S2, the small blind S3 and the big blind S5, so S4 neither posts nor plays.

**Example (seats filling).** Players in S0 to S5 with the button on S1. During the hand a new player sits down in S7. Next hand the button moves to S2, the small blind is S3 and the big blind S4, and S7 is dealt in without posting anything. S7 posts the big blind for the first time when the button reaches S4.

**Example (to heads-up).** Players in S1, S3 and S5 with the button on S1. S5 loses all their chips. Next hand only S1 and S3 are dealt in: the button moves to S3, which posts the small blind, and S1 posts the big blind.

## 6. Betting rounds and the order of action

6.1. There are four betting rounds: pre-flop, flop, turn and river. Each street’s bets start from zero, apart from the blinds pre-flop.

6.2. Pre-flop, the first player to act is the one left of the big blind, or the button heads-up (section 4). On later streets it is the first player left of the button who has not folded and is not all-in.

6.3. Action passes clockwise and skips players who have folded or are all-in. A betting round ends when every player who has not folded and is not all-in has acted at least once on the street and has a street bet equal to the current bet. Pre-flop the big blind’s option counts as a turn to act, so the round does not end until the big blind has acted.

6.4. If at most one player who has not folded still has chips, and everyone has matched the current bet or is all-in, there is no more betting. The remaining board cards are dealt and the hand goes to showdown.

6.5. If every player but one folds, that player wins the pot at once. The remaining board cards are not dealt and no cards are shown.

**Example.** Six players with the button on S2. Pre-flop S5 acts first, then S0, S1, S2, S3 (small blind) and S4 (big blind). If everyone calls, S4 may check or raise. On the flop S3 acts first. If S3 is all-in by then, S4 acts first.

## 7. Legal actions and amounts

7.1. On their turn a player may **fold**, **check** if their street bet equals the current bet, **call** the difference otherwise, or **bet** (when the current bet is zero) or **raise** (when it is not), within the limits below.

7.2. **Calling.** The amount to call is the current bet minus the player’s street bet. A player with fewer chips may call all-in for less.

7.3. **Minimum bet.** The minimum opening bet on the flop, turn and river is one big blind.

7.4. **Minimum raise.** A raise must increase the current bet by at least the **minimum raise increment**: the largest full bet or raise increment made on this street so far, and never less than one big blind. Pre-flop the big blind counts as the first bet, so the first raise is to at least two big blinds.

7.5. **Maximum.** In no-limit a player may bet or raise any amount up to all their chips.

7.6. **All-in for less.** A player may always put in all their chips, even if that is less than a minimum bet or raise. An all-in that raises the current bet by less than the minimum raise increment is an **incomplete raise**. It changes the current bet but is not a full raise: it does not change the minimum raise increment, and section 8 decides whether it reopens the betting.

7.7. `legal_actions(state)` lists fold (only when there is something to call), check or call, and bet or raise with the exact minimum and maximum street totals. When a player’s chips do not reach the minimum, their only bet or raise is all-in.

7.8. A player may bet or raise only while at least one other player who has not folded still has chips. When everyone else still in is all-in, nobody could call a raise, so the player may only check, call or fold.

**Example (pre-flop).** S5 raises to 300, an increment of 200. S0 may call 300, or re-raise to at least 500 (300 + 200) and at most all-in at 10,000.

**Example (post-flop).** On the flop S3 bets 100, the minimum. S4 raises to 350, an increment of 250. S5 may re-raise to at least 600 (350 + 250). If S5 had 80 chips in total, S5 could still go all-in for 80, calling for less.

**Example (short stack).** S1 has 150 chips and faces a bet of 100. S1 may fold, call 100 or go all-in for 150. A raise to the minimum of 200 is not possible, so all-in is S1’s only raise.

**Example (nobody left to raise).** Heads-up, S0 on the button goes all-in for 10,000 and S2 has 20,000. S2 may call 9,900 more or fold, but not raise. In the same way, a big blind of 60 all-in heads-up leaves the button only to call 50 more or fold; 40 of that call is then returned under rule 9.1.

## 8. Incomplete raises and reopening the betting

8.1. When the action returns to a player who has already acted on this street, they may raise only if they now face at least one full raise: the current bet must be at least the minimum raise increment more than it was just after their last action. Otherwise they may only call or fold.

8.2. Several incomplete raises add up. Once together they reach a full raise over what a player last acted on, that player may raise again.

8.3. A player who has not yet acted on the street may always raise.

**Example (does not reopen).** On the flop S1 bets 100. S2 goes all-in for 150, an incomplete raise of 50. S3 calls 150. Back at S1, the current bet of 150 is only 50 more than the 100 S1 acted on, which is less than the full raise of 100. S1 may call 50 more or fold, but not raise. S3 could have raised instead of calling, because S3 had not yet acted; the minimum would have been to 250 (150 + 100).

**Example (adds up).** On the flop S1 bets 100. S2 goes all-in for 150 and S3 goes all-in for 210. Back at S1, the current bet is 110 more than S1’s 100, at least a full raise, so S1 may re-raise. The minimum is to 310, because the minimum raise increment is still 100.

## 9. Pots, side pots and uncalled bets

9.1. **Uncalled bets.** When betting stops, if one player’s contribution is larger than every other player’s contribution, folded players included, nobody called the difference. That excess over the next largest contribution is returned to the player before the pots are formed.

9.2. **Side pots.** The pot is then split by contribution levels. Take the distinct contributions of the players who have not folded, from smallest to largest. Each level makes one pot. Every player, folded or not, pays into it the part of their contribution between the previous level and this one. A pot can be won only by players who have not folded and who contributed at least its level. The first pot is the **main pot**, and the others are **side pots**.

9.3. Antes and blinds are contributions like any other.

**Example (uncalled bet).** On the river S1 bets 500 and everyone else folds. S1’s 500 is returned and S1 wins the pot as it stood before the bet. Pre-flop, if everyone folds to the big blind, the big blind’s 100 is matched only to the 50 the small blind put in, so 50 is returned to the big blind, which then wins the 100 in the pot (plus any antes).

**Example (all-in for less).** Neither S1 nor S2 is in the blinds. Pre-flop S1 goes all-in for 1,000, S2 calls all-in with 400, and everyone else folds, including both blinds. S1’s contribution is 600 more than anyone else’s, so 600 is returned to S1. The pot of 950 (400 from each of them plus the 150 in blinds) is played for at showdown.

**Example (side pots).** Five players contribute A 100, B 300, C 600, D 600 and E 200. A, B, C and D reach showdown; E folded. The levels are 100, 300 and 600.

| Pot | From each player | Total | Eligible |
| --- | --- | --- | --- |
| Main | A 100, B 100, C 100, D 100, E 100 | 500 | A, B, C, D |
| Side 1 | B 200, C 200, D 200, E 100 | 700 | B, C, D |
| Side 2 | C 300, D 300 | 600 | C, D |

The pots add up to the 1,800 contributed. If B has the best hand, B wins the main pot and side pot 1, and side pot 2 goes to the better of C and D.

## 10. Hand rankings

10.1. Each player still in at showdown makes the best five-card hand from their two hole cards and the five board cards, in any combination. Hands rank from high to low: straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, one pair and high card. The ace plays high, or low in A-2-3-4-5. Suits never rank, and cards outside the best five never play.

10.2. The engine ranks hands with the existing Deuces evaluator, which handles seven cards directly ([its notice](../licenses/Deuces.txt)).

**Example.** The board is K♠ K♥ 7♦ 7♣ 2♠. A holds A♥ 3♦ and B holds Q♣ J♣. Both play two pair, kings and sevens; A’s ace kicker beats B’s queen, so A wins. If B held A♣ 4♣ instead, both would play K K 7 7 A and split the pot.

## 11. Showdown, splits and odd chips

11.1. Each pot is awarded on its own, to the best hand among the players eligible for it. Equal best hands split the pot equally.

11.2. **Odd chips.** When a pot does not divide evenly, the leftover chips go one at a time to the winners in clockwise order starting from the first seat left of the button. Each pot’s odd chips are handed out separately.

**Example (odd chip).** A pot of 301 is split between S2 and S5 with the button on S4. S5 is the first winner left of the button, so S5 gets 151 and S2 gets 150.

**Example (three-way split).** A pot of 100 is split between S1, S3 and S6 with the button on S6. Going clockwise from S7, the winners come in the order S1, S3, S6, so they get 34, 33 and 33.

## 12. Showing and mucking

12.1. When the hand goes to showdown under rule 6.4, because at most one player still in has chips behind, every hand still in is turned face up at once, before any remaining board cards are dealt. This includes a river where the last call puts a player all-in. The hands are listed clockwise from the first player left of the button.

12.2. At any other showdown, hands are shown in order. If there was a bet or raise on the river, the last player to bet or raise shows first. Otherwise the first player left of the button who is still in shows first. Then the others follow clockwise.

12.3. The first hand is always shown. Each later player shows only if their hand beats or ties the best hand shown so far for at least one pot they are eligible for, or no hand has yet been shown for that pot. Otherwise their hand is mucked, and other players never see it. Every pot winner is therefore shown.

12.4. A player who has folded never shows. A player who wins because everyone else folded does not show. Players cannot choose to show or muck in 1.0. Hand histories keep a mucked hand only for the player who held it.

**Example.** On the river S1 bets and S3 and S5 call, with the button on S0. S1 shows first with two pair. S3 holds one pair, which loses to two pair, so S3 mucks. S5 holds a straight, so S5 shows and wins. If the river had been checked round, S1 would still show first, as the first player left of the button.

**Example (side pot).** The button is on S0. A in S1 went all-in on the turn, so A is eligible only for the main pot. B in S2 and C in S3 kept betting, and the river was checked. A shows first, as the first player left of the button, with a flush. B holds three of a kind, which cannot win the main pot; but no hand has yet been shown for the side pot, which A cannot win, so B shows. C holds one pair, which loses to A’s flush in the main pot and to B’s three of a kind in the side pot, so C mucks.

## 13. Timeouts and disconnections

13.1. Each turn has a clock: 20 seconds by default, then the player’s **time bank**. The bank starts at 30 seconds, is spent by any time a player takes beyond the clock, is emptied by a timeout while connected, and regains 2 seconds for every hand the player is dealt into, up to its starting size. When the clock and the bank both run out, the player checks if checking is legal, and otherwise folds. Tables may set other times.

13.2. A disconnected player keeps their seat. Their turns time out as in 13.1, but without their time bank, so the table does not wait longer for someone who is not there. A player who is away for a full orbit is sat out when the hand ends. An orbit is as many hands in a row as there were players dealt into the last of them, and a hand counts as away when the player was dealt in, never acted for themselves and was disconnected or timed out. Acting, or reconnecting, starts the count again. Bots are never sat out this way.

**Example.** On the flop no one has bet and S2’s clock runs out, so S2 checks. Later S4 bets and S2’s clock runs out again, so S2 folds. Pre-flop, a big blind whose clock runs out with no raise checks; a small blind whose clock runs out folds.

**Example (time bank).** S0 acts 26.5 seconds into a 20-second turn, so 6.5 seconds come out of a 30-second bank, leaving 23.5. When S0 is dealt into the next hand the bank grows to 25.5.

**Example (away).** Three players are dealt in and S0 disconnects. S0 times out or is folded out of three hands in a row, so S0 is sat out when the third ends and is not dealt into the fourth.

## Choices

These are the points where card rooms differ, with the option this game uses.

| Topic | Chosen | Alternatives | Why |
| --- | --- | --- | --- |
| Button movement | Moving button (rule 5.2) | Dead button, so no one skips a blind when a player leaves | Simple and predictable at online tables where players come and go; a skipped blind costs play chips only. |
| Joining and returning | Dealt in from the next hand, with no missed-blind charges (rule 2.2) | Wait for the big blind, or post a big blind to play at once | Simple for players and the server. The action clock and sitting out after an orbit (P3.3) limit blind-dodging. Revisit if leaderboards (P6.3) show abuse. |
| Ante | Optional ante from every player, zero by default (rule 3.2) | A single big-blind ante | Matches the existing ante wording in this plan; any ante structure can be added as a table setting later. |
| Short big blind | Others must still call a full big blind (rule 3.3) | The short amount becomes the current bet | Common tournament and online rule; keeps the minimum raise unchanged. |
| Reopening after an incomplete raise | Only a full raise in total reopens (section 8) | A raise of at least half the minimum reopens | Poker TDA rule, standard online. |
| Odd chips | One at a time from the first seat left of the button, per pot (rule 11.2) | To the best suit by high card | Required by the plan, simple and deterministic. |
| Showing hands | Auto-muck hands that cannot win or tie; all-in hands are tabled (section 12) | Every hand shown at showdown, or players choose | Matches online practice and keeps mucked cards private, which the hand replayer relies on (P6.1). |
| Burn cards | Burned before each street (rule 1.3) | No burn cards | Matches live dealing, so a deck order replays exactly as a dealer would deal it. |
| Timeout action | Check if possible, otherwise fold (rule 13.1) | Always fold | The plan’s default; never folds a free hand. |
| Time bank | 30 seconds, regaining 2 per hand; not used while disconnected (rule 13.1 and 13.2) | A fixed bank per session, or none | Lets players think on big decisions without letting a missing player stall the table. |
| Bots and people | Bots fill the seats people leave and give them up to people who want them (rule 2.4) | Separate tables for bots and people; bots only on request | There is always a game to join, and a table of people never waits on a bot. Bots are always labelled (D-7). |
| Straddles, run it twice, insurance, rake | None | Various | Not part of 1.0; play money has no rake. |
