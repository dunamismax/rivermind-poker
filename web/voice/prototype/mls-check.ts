// ts-mls in the browser (P4C.1): three members of an MLS group made on this
// page, by external commits, agree on the SFrame base key. It shows the engine
// has the WebCrypto that ciphersuite 0x0001 needs (Ed25519 and X25519) and
// that ts-mls bundles for it. src/lib/voice/mls-design.spec.ts checks the rest.
import { createGroup, type ClientState } from 'ts-mls/clientState.js';
import {
	createGroupInfoWithExternalPubAndRatchetTree,
	joinGroupExternal
} from 'ts-mls/createCommit.js';
import { getCiphersuiteFromName } from 'ts-mls/crypto/ciphersuite.js';
import { getCiphersuiteImpl } from 'ts-mls/crypto/getCiphersuiteImpl.js';
import { defaultCapabilities } from 'ts-mls/defaultCapabilities.js';
import { generateKeyPackage } from 'ts-mls/keyPackage.js';
import { mlsExporter } from 'ts-mls/keySchedule.js';
import { defaultLifetime } from 'ts-mls/lifetime.js';
import { processPublicMessage } from 'ts-mls/processMessages.js';
import { emptyPskIndex } from 'ts-mls/pskIndex.js';

export type MlsCheck = { epoch: number; baseKeys: string[]; joinMs: number[] };

export async function mlsCheck(): Promise<MlsCheck> {
	const impl = await getCiphersuiteImpl(
		getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519')
	);
	const text = new TextEncoder();
	const member = (name: string) =>
		generateKeyPackage(
			{ credentialType: 'basic', identity: text.encode(name) },
			defaultCapabilities(),
			defaultLifetime,
			[],
			impl
		);
	const first = await member('player-0');
	const states: ClientState[] = [
		await createGroup(text.encode('table'), first.publicPackage, first.privatePackage, [], impl)
	];
	const joinMs: number[] = [];
	for (let n = 1; n < 3; n++) {
		const info = await createGroupInfoWithExternalPubAndRatchetTree(states.at(-1)!, [], impl);
		const next = await member(`player-${n}`);
		const started = performance.now();
		const joined = await joinGroupExternal(
			info,
			next.publicPackage,
			next.privatePackage,
			false,
			impl
		);
		joinMs.push(Math.round(performance.now() - started));
		for (let m = 0; m < states.length; m++) {
			states[m] = (
				await processPublicMessage(states[m], joined.publicMessage, emptyPskIndex, impl)
			).newState;
		}
		states.push(joined.newState);
	}
	const baseKeys: string[] = [];
	for (const state of states) {
		const key = await mlsExporter(
			state.keySchedule.exporterSecret,
			'SFrame 1.0 Base Key',
			new Uint8Array(),
			16,
			impl
		);
		baseKeys.push([...key].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
	}
	return { epoch: Number(states[0].groupContext.epoch), baseKeys, joinMs };
}
