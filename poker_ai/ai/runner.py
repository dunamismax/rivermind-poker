"""Train or resume a poker agent."""
import inspect
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Union

import click
import joblib
import yaml

from poker_ai import utils
from poker_ai.ai.multiprocess.server import Server
from poker_ai.ai.singleprocess.train import simple_search


log = logging.getLogger("poker_ai.ai.runner")


def _safe_search(server: Server):
    """Safely run the server, and allow user to control c."""
    try:
        server.search()
    except (KeyboardInterrupt, SystemExit):
        log.info(
            "Early termination of program. Please wait for workers to "
            "terminate."
        )
    finally:
        server.terminate()
    log.info("All workers terminated. Quitting program - thanks for using me!")


@click.group()
def train():
    """Train a poker AI."""
    pass


_SINGLE_PROCESS_KEYS = set(inspect.signature(simple_search).parameters)
_SERVER_KEYS = set(inspect.signature(Server.__init__).parameters) - {"self"}


def load_resume_state(
    server_config_path: Union[str, Path], lut_path: Optional[str] = None
) -> Tuple[bool, Dict[str, Any]]:
    """
    Read a saved `server.gz` and return `(single_process, kwargs)`.

    `kwargs` suit `simple_search` or `Server`. Accepts checkpoints written
    before RM-02: single-process files then held the `train start` options
    (with `nickname` and `sync_*` flags) and no `save_path`, which is taken
    from the checkpoint's directory. A relative `lut_path` resolves against
    the current directory, as it did when training started, unless
    `lut_path` overrides it. If `agent.joblib` embeds a newer resume state
    than `server.gz` (a dump interrupted between the two files), the newer
    state wins so iterations are not applied twice.
    """
    try:
        config: Dict[str, Any] = joblib.load(server_config_path)
    except FileNotFoundError:
        raise FileNotFoundError(
            f"Server config file not found at the path: {server_config_path}\n "
            f"Please set the path to a valid file dumped by a previous session."
        )
    agent_path = config.get("agent_path")
    if agent_path and os.path.isfile(agent_path):
        embedded = joblib.load(agent_path).get("resume_state")
        if embedded and embedded["start_timestep"] > config["start_timestep"]:
            log.warning(
                "agent.joblib is newer than server.gz; resuming from iteration "
                f"{embedded['start_timestep']}."
            )
            config = embedded
    config = dict(config)
    if lut_path is not None:
        config["lut_path"] = lut_path
    if config.get("lut_path"):
        config["lut_path"] = os.path.abspath(str(config["lut_path"]))
    single_process = bool(config.get("single_process"))
    if single_process:
        if "save_path" not in config:
            source = agent_path or server_config_path
            config["save_path"] = os.path.dirname(os.path.abspath(str(source)))
        kwargs = {k: v for k, v in config.items() if k in _SINGLE_PROCESS_KEYS}
    else:
        kwargs = {k: v for k, v in config.items() if k in _SERVER_KEYS}
    return single_process, kwargs


@train.command()
@click.option(
    "--server_config_path",
    default="./server.gz",
    help="The path to the previous server.gz file from a previous study.",
)
@click.option(
    "--lut_path",
    default=None,
    help=(
        "Override the saved card table directory, for example when the run "
        "was started with a relative path from another directory."
    ),
)
def resume(server_config_path: str, lut_path: Optional[str]):
    """
    Continue training agent from config loaded from file.

    The saved mode is kept: single-process runs resume in this process and
    multiprocess runs restart the worker server.

    ...

    Parameters
    ----------
    server_config_path : str
        Path to server configurations.
    """
    single_process, kwargs = load_resume_state(server_config_path, lut_path)
    log.info(
        f"Resuming {'single' if single_process else 'multi'}-process training "
        f"at iteration {kwargs['start_timestep']} of {kwargs['n_iterations']}."
    )
    if single_process:
        simple_search(**kwargs)
    else:
        server = Server.from_dict(kwargs)
        _safe_search(server)


@train.command()
@click.option(
    "--strategy_interval",
    default=20,
    help="Update the current strategy whenever the iteration % strategy_interval == 0.",
)
@click.option(
    "--n_iterations",
    default=1500,
    help="The total number of iterations we should train the model for.",
)
@click.option(
    "--lcfr_threshold",
    default=400,
    show_default=True,
    help=(
        "Linear CFR window: discount only at iterations strictly before this "
        "one (Pluribus: the first 400 minutes)."
    ),
)
@click.option(
    "--discount_interval",
    default=10,
    show_default=True,
    help=(
        "Within the linear CFR window, discount regret and strategy whenever "
        "iteration % discount_interval == 0 (Pluribus: every 10 minutes)."
    ),
)
@click.option(
    "--prune_threshold",
    default=200,
    show_default=True,
    help=(
        "When a uniform random number is less than 95%, and the iteration > "
        "prune_threshold, use CFR with pruning."
    ),
)
@click.option(
    "--c",
    default=-20000,
    help=(
        "Pruning threshold for regret, which means when we are using CFR with "
        "pruning and have a state with a regret of less than `c`, then we'll "
        "elect to not recusrively visit it and it's child nodes."
    ),
)
@click.option("--n_players", default=3, help="The number of players in the game.")
@click.option(
    "--dump_iteration",
    default=20,
    help=(
        "When the iteration % dump_iteration == 0, we will compute a new strategy "
        "and write that to the accumlated strategy, which gets normalised at a "
        "later time."
    ),
)
@click.option(
    "--update_threshold",
    default=400,
    help=(
        "When the iteration is greater than update_threshold we can start "
        "updating the strategy."
    ),
)
@click.option(
    "--lut_path",
    default=".",
    help=(
        "The path to the files for clustering the infosets."
    ),
)
@click.option(
    "--pickle_dir",
    default=False,
    help=(
        "Whether or not the lut files are pickle files. This lookup "
        "method is deprecated."
    ),
)
@click.option(
    "--single_process/--multi_process",
    default=False,
    help="Either use or don't use multiple processes.",
)
@click.option(
    "--sync_update_strategy/--async_update_strategy",
    default=False,
    help="Do or don't synchronise update_strategy.",
)
@click.option(
    "--sync_cfr/--async_cfr", default=False, help="Do or don't synchronuse CFR."
)
@click.option(
    "--sync_discount/--async_discount",
    default=False,
    help="Do or don't synchronise the discounting.",
)
@click.option(
    "--sync_serialise/--async_serialise",
    default=False,
    help="Do or don't synchronise the serialisation.",
)
@click.option("--nickname", default="", help="The nickname of the study.")
def start(
    strategy_interval: int,
    n_iterations: int,
    lcfr_threshold: int,
    discount_interval: int,
    prune_threshold: int,
    c: int,
    n_players: int,
    dump_iteration: int,
    update_threshold: int,
    lut_path: str,
    pickle_dir: bool,
    single_process: bool,
    sync_update_strategy: bool,
    sync_cfr: bool,
    sync_discount: bool,
    sync_serialise: bool,
    nickname: str,
):
    """Train agent from scratch."""
    # Write config to file, and create directory to save results in.
    config: Dict[str, int] = {**locals()}
    save_path: Path = utils.io.create_dir(nickname)
    with open(save_path / "config.yaml", "w") as steam:
        yaml.dump(config, steam)
    if single_process:
        log.info(
            "Only one process specified so using poker_ai.ai.singleprocess."
            "simple_search for the optimisation."
        )
        simple_search(
            save_path=save_path,
            lut_path=lut_path,
            pickle_dir=pickle_dir,
            strategy_interval=strategy_interval,
            n_iterations=n_iterations,
            lcfr_threshold=lcfr_threshold,
            discount_interval=discount_interval,
            prune_threshold=prune_threshold,
            c=c,
            n_players=n_players,
            dump_iteration=dump_iteration,
            update_threshold=update_threshold,
        )
    else:
        log.info(
            "Mulitple processes specifed so using poker_ai.ai.multiprocess."
            "server.Server for the optimisation."
        )
        # Create the server that controls/coordinates the workers.
        server = Server(
            strategy_interval=strategy_interval,
            n_iterations=n_iterations,
            lcfr_threshold=lcfr_threshold,
            discount_interval=discount_interval,
            prune_threshold=prune_threshold,
            c=c,
            n_players=n_players,
            dump_iteration=dump_iteration,
            update_threshold=update_threshold,
            save_path=save_path,
            lut_path=lut_path,
            pickle_dir=pickle_dir,
            sync_update_strategy=sync_update_strategy,
            sync_cfr=sync_cfr,
            sync_discount=sync_discount,
            sync_serialise=sync_serialise,
        )
        _safe_search(server)


if __name__ == "__main__":
    train()
