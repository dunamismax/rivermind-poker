import time
from typing import Dict

import click
from blessed import Terminal

from poker_ai.games.short_deck.state import new_game, ShortDeckPokerState
from poker_ai.policies import CheckpointPolicy, Policy, RandomPolicy, seat_view
from poker_ai.terminal.ascii_objects.card_collection import AsciiCardCollection
from poker_ai.terminal.ascii_objects.player import AsciiPlayer
from poker_ai.terminal.ascii_objects.logger import AsciiLogger
from poker_ai.terminal.render import print_footer, print_header, print_log, print_table
from poker_ai.terminal.results import UserResults
from poker_ai.utils.algos import rotate_list

# Pause after each bot action so the human can follow the hand.
BOT_DELAY_SECONDS = 0.8


def make_policy(agent: str, strategy_path: str = "") -> Policy:
    """Return the bot policy for `--agent`."""
    if agent == "random":
        return RandomPolicy()
    if agent == "offline":
        return CheckpointPolicy.from_checkpoint(strategy_path)
    raise ValueError(f"Unknown agent: {agent}")


@click.command()
@click.option('--lut_path', default=".", type=str)
@click.option('--pickle_dir', required=False, default=False, type=bool)
@click.option('--agent', default="offline", type=click.Choice(["random", "offline"]))
@click.option('--strategy_path', required=False, default="", type=str)
@click.option('--debug_quick_start/--no_debug_quick_start', default=False)
def run_terminal_app(
    lut_path: str,
    pickle_dir: bool,
    agent: str = "offline",
    strategy_path: str = "",
    debug_quick_start: bool = False
):
    """Play a three-seat table. Use --agent random for a game without training data."""
    if debug_quick_start:
        agent = "random"
    if agent == "offline" and not strategy_path:
        raise click.UsageError("Offline play requires --strategy_path and matching card tables.")
    term = Terminal()
    log = AsciiLogger(term)
    n_players: int = 3
    if agent == "random":
        state: ShortDeckPokerState = new_game(n_players, {}, load_card_lut=False)
    else:
        state = new_game(
            n_players,
            lut_path=lut_path,
            pickle_dir=pickle_dir
        )
    n_table_rotations: int = 0
    selected_action_i: int = 0
    positions = ["left", "middle", "right"]
    names = {"left": "BOT 1", "middle": "BOT 2", "right": "HUMAN"}
    bot: Policy = make_policy(agent, strategy_path)
    user_results: UserResults = UserResults()
    with term.cbreak(), term.hidden_cursor():
        while True:
            # Construct ascii objects to be rendered later.
            ascii_players: Dict[str, AsciiPlayer] = {}
            state_players = rotate_list(state.players[::-1], n_table_rotations)
            og_name_to_position = {}
            og_name_to_name = {}
            for player_i, player in enumerate(state_players):
                position = positions[player_i]
                is_human = names[position].lower() == "human"
                ascii_players[position] = AsciiPlayer(
                    *player.cards,
                    term=term,
                    name=names[position],
                    og_name=player.name,
                    hide_cards=not is_human and not state.is_terminal,
                    folded=not player.is_active,
                    is_turn=player.is_turn,
                    chips_in_pot=player.n_bet_chips,
                    chips_in_bank=player.n_chips,
                    is_small_blind=player.is_small_blind,
                    is_big_blind=player.is_big_blind,
                    is_dealer=player.is_dealer,
                )
                og_name_to_position[player.name] = position
                og_name_to_name[player.name] = names[position]
                if player.is_turn:
                    current_player_name = names[position]
            public_cards = AsciiCardCollection(*state.community_cards)
            if state.is_terminal:
                legal_actions = ["quit", "new game"]
                human_should_interact = True
            else:
                og_current_name = state.current_player.name
                human_should_interact = og_name_to_position[og_current_name] == "right"
                if human_should_interact:
                    legal_actions = state.legal_actions
                else:
                    legal_actions = []
            # Render game.
            print(term.home + term.white + term.clear)
            print_header(term, state, og_name_to_name)
            print_table(
                term,
                ascii_players,
                public_cards,
                n_table_rotations,
                n_chips_in_pot=state._table.pot.total,
            )
            print_footer(term, selected_action_i, legal_actions)
            print_log(term, log)
            # Make action of some kind.
            if human_should_interact:
                # Incase the legal_actions went from length 3 to 2 and we had
                # previously picked the last one.
                selected_action_i %= len(legal_actions)
                key = term.inkey(timeout=None)
                if key.lower() == "q":
                    log.info(term.pink("quit"))
                    break
                elif key.name == "KEY_LEFT":
                    selected_action_i -= 1
                    if selected_action_i < 0:
                        selected_action_i = len(legal_actions) - 1
                elif key.name == "KEY_RIGHT":
                    selected_action_i = (selected_action_i + 1) % len(legal_actions)
                elif key.name == "KEY_ENTER":
                    action = legal_actions[selected_action_i]
                    if action == "quit":
                        user_results.add_result(strategy_path, agent, state, og_name_to_name)
                        log.info(term.pink("quit"))
                        break
                    elif action == "new game":
                        user_results.add_result(strategy_path, agent, state, og_name_to_name)
                        log.clear()
                        log.info(term.green("new game"))
                        if agent == "random":
                            state: ShortDeckPokerState = new_game(
                                n_players, state.card_info_lut, load_card_lut=False,
                            )
                        else:
                            state: ShortDeckPokerState = new_game(
                                n_players, state.card_info_lut, pickle_dir=pickle_dir,
                            )
                        n_table_rotations -= 1
                        if n_table_rotations < 0:
                            n_table_rotations = n_players - 1
                    else:
                        log.info(term.green(f"{current_player_name} chose {action}"))
                        state: ShortDeckPokerState = state.apply_action(action)
            else:
                action = bot.choose(seat_view(state))
                time.sleep(BOT_DELAY_SECONDS)
                log.info(f"{current_player_name} chose {action}")
                state: ShortDeckPokerState = state.apply_action(action)


if __name__ == "__main__":
    run_terminal_app()
