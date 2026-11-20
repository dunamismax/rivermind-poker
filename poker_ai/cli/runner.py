import click

from poker_ai.ai.runner import train
from poker_ai.benchmark import evaluate_command
from poker_ai.clustering.runner import cluster
from poker_ai.terminal.runner import run_terminal_app
from poker_ai.web.cli import protocol_schema, serve
from rivermind.bots.cli import blueprint, tables
from rivermind.server.cli import moderation, serve_nl


@click.group()
@click.version_option(package_name="rivermind-poker")
def cli():
    """Train and play against RiverMind Poker bots."""


cli.add_command(train, name="train")
cli.add_command(cluster, name="cluster")
cli.add_command(run_terminal_app, name="play")
cli.add_command(evaluate_command, name="evaluate")
cli.add_command(serve, name="serve")
cli.add_command(serve_nl, name="serve-nl")
cli.add_command(moderation, name="moderation")
cli.add_command(protocol_schema, name="protocol-schema")
cli.add_command(tables, name="tables")
cli.add_command(blueprint, name="blueprint")
