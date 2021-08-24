/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='../../../src/vs/vscode.d.ts'/>

import { AutoTunnelRequest, ResolveSSHConnectionRequest, ResolveSSHConnectionResponse } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb';
import { LocalAppClient } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb_service';
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import fetch, { Response } from 'node-fetch';
import { performance } from 'perf_hooks';
import * as tmp from 'tmp';
import * as util from 'util';
import * as vscode from 'vscode';
import { grpc } from '@improbable-eng/grpc-web';
const streamPipeline = util.promisify(require('stream').pipeline);

interface SSHConnectionParams {
	workspaceId: string
	instanceId: string
	gitpodHost: string
}

interface LocalAppConfig {
	gitpodHost: string
	configFile: string
	apiPort: number
	pid: number
	logPath: string
}

interface Lock {
	value: string
	deadline: number
}

interface LocalAppInstallation {
	path: string
	etag: string | null
}

export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Gitpod');

	// TODO(ak) commands to show logs and stop local apps
	// TODO(ak) auto stop local apps if not used for 3 hours

	function throwIfCancelled(token: vscode.CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new Error('cancelled');
		}
	}

	const lockPrefix = 'lock/';
	const fastLockTimeout = 30000;
	const slowLockTimeout = 300000;
	function releaseStaleLocks(): void {
		for (const key of context.globalState.keys()) {
			if (key.startsWith(lockPrefix)) {
				const lock = context.globalState.get<Lock>(key);
				if (typeof lock !== 'object' || performance.now() >= lock.deadline) {
					const lockName = key.substr(lockPrefix.length);
					output.appendLine(`cancel stale lock: ${lockName}`);
					context.globalState.update(key, undefined);
				}
			}
		}
	}
	let lockCount = 0;
	async function withLock<T>(lockName: string, op: (token: vscode.CancellationToken) => Promise<T>, timeout: number): Promise<T> {
		output.appendLine(`acquiring lock: ${lockName}`);
		const lockKey = lockPrefix + lockName;
		const value = vscode.env.sessionId + '/' + lockCount++;
		let currentLock: Lock | undefined;
		let deadline: number | undefined;
		const updateTimeout = 150;
		while (currentLock?.value !== value) {
			currentLock = context.globalState.get<Lock>(lockKey);
			if (!currentLock) {
				deadline = performance.now() + timeout + updateTimeout * 2;
				await context.globalState.update(lockKey, <Lock>{ value, deadline });
			}
			// TODO(ak) env.globaState.onDidChange instead, see https://github.com/microsoft/vscode/issues/131182
			await new Promise(resolve => setTimeout(resolve, updateTimeout));
			currentLock = context.globalState.get<Lock>(lockKey);
		}
		output.appendLine(`acquired lock: ${lockName}`);
		const tokenSource = new vscode.CancellationTokenSource();
		let timer = setInterval(() => {
			currentLock = context.globalState.get<Lock>(lockKey);
			if (currentLock?.value !== value) {
				tokenSource.cancel();
			}
		}, updateTimeout);
		try {
			const result = await op(tokenSource.token);
			return result;
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			output.appendLine(`released lock: ${lockName}`);
			await context.globalState.update(lockKey, undefined);
		}
	}

	const releaseStaleLocksTimer = setInterval(() => releaseStaleLocks(), fastLockTimeout);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(releaseStaleLocksTimer)));

	function downloadLocalApp(gitpodHost: string): Promise<Response> {
		let downloadUri = vscode.Uri.parse(gitpodHost);
		if (process.platform === 'win32') {
			downloadUri = downloadUri.with({
				path: '/static/bin/gitpod-local-companion-windows.exe'
			});
		} else if (process.platform === 'darwin') {
			downloadUri = downloadUri.with({
				path: '/static/bin/gitpod-local-companion-darwin'
			});
		} else {
			downloadUri = downloadUri.with({
				path: '/static/bin/gitpod-local-companion-linux'
			});
		}
		output.appendLine(`fetching the local app from ${downloadUri.toString()}`);
		return fetch(downloadUri.toString());
	}

	async function installLocalApp(download: Response, token: vscode.CancellationToken): Promise<LocalAppInstallation> {
		try {
			const fileExtension = process.platform === 'win32' ? '.exe' : undefined;
			const installationPath = await new Promise<string>((resolve, reject) =>
				tmp.file({ prefix: 'gitpod-local-companion', postfix: fileExtension }, (err, path) => {
					if (err) {
						return reject(err);
					}
					return resolve(path);
				})
			);
			throwIfCancelled(token);
			output.appendLine(`installing the local app to ${installationPath}`);
			throwIfCancelled(token);
			await streamPipeline(download.body, fs.createWriteStream(installationPath));
			throwIfCancelled(token);
			if (process.platform !== 'win32') {
				await fs.promises.chmod(installationPath, '755');
				throwIfCancelled(token);
			}
			const installation: LocalAppInstallation = { path: installationPath, etag: download.headers.get('etag') };
			output.appendLine(`installing the local app: ${JSON.stringify(installation, undefined, 2)}`);
			return installation;
		} catch (e) {
			output.appendLine(`failed to install the local app: ${e}`);
			throw e;
		}
	}

	async function startLocalApp(gitpodHost: string, installation: LocalAppInstallation, token: vscode.CancellationToken): Promise<LocalAppConfig> {
		try {
			const [configFile, apiPort] = await Promise.all([new Promise<string>((resolve, reject) =>
				tmp.file({ prefix: 'gitpod_ssh_config' }, (err, path) => {
					if (err) {
						return reject(err);
					}
					return resolve(path);
				})
			), new Promise<number>(resolve => {
				const server = http.createServer();
				server.listen(0, 'localhost', () => {
					resolve((server.address() as net.AddressInfo).port);
					server.close();
				});
			})]);
			throwIfCancelled(token);
			output.appendLine(`starting the local app with the config: ${JSON.stringify({ gitpodHost, configFile, apiPort }, undefined, 2)}`);
			const logPath = installation.path + '.log';
			let spawnTimer: NodeJS.Timeout | undefined;
			const pid = await new Promise<number>((resolve, reject) => {
				const logStream = fs.createWriteStream(logPath);
				logStream.on('error', reject);
				logStream.on('open', () => {
					if (token.isCancellationRequested) {
						reject(new Error('cancelled'));
					}
					const localAppProcess = cp.spawn(installation.path, {
						detached: true,
						stdio: ['ignore', logStream, logStream],
						env: {
							...process.env,
							GITPOD_HOST: gitpodHost,
							GITPOD_LCA_SSH_CONFIG: configFile,
							GITPOD_LCA_API_PORT: String(apiPort),
							GITPOD_LCA_AUTO_TUNNEL: String(false),
							GITPOD_LCA_AUTH_REDIRECT_URL: `${vscode.env.uriScheme}://${context.extension.id}${authCompletePath}`
						}
					});
					localAppProcess.on('error', reject);
					localAppProcess.on('exit', code => reject(new Error('unexpectedly exit with code: ' + code)));
					localAppProcess.unref();
					if (localAppProcess.pid) {
						// TODO(ak) when Node.js > 14.17
						// localAppProcess.on('spwan', () => resolve(localAppProcess.pid)));
						spawnTimer = setInterval(() => {
							try {
								process.kill(localAppProcess.pid, 0);
								resolve(localAppProcess.pid);
							} catch { }
						}, 150);
					}
				});
			}).finally(() => {
				if (spawnTimer) {
					clearInterval(spawnTimer);
				}
			});
			output.appendLine(`the local app has been stared: ${JSON.stringify({ pid, log: vscode.Uri.file(logPath).toString() }, undefined, 2)}`);
			return { gitpodHost, configFile, apiPort, pid, logPath };
		} catch (e) {
			output.appendLine(`failed to start the local app: ${e}`);
			throw e;
		}
	}

	/**
	 * **Important: it should not call the local app to manage in 30sec**
	 */
	async function ensureLocalApp(gitpodHost: string, configKey: string, installationKey: string, token: vscode.CancellationToken): Promise<LocalAppConfig> {
		let download: Response | Error;
		try {
			download = await downloadLocalApp(gitpodHost);
			throwIfCancelled(token);
			if (!download.ok) {
				download = new Error(`unexpected download response ${download.statusText} (${download.status})`);
			}
		} catch (e) {
			download = e;
		}
		let config = context.globalState.get<LocalAppConfig>(configKey);
		let installation = context.globalState.get<LocalAppInstallation>(installationKey);
		if (installation) {
			const upgrade = !(download instanceof Error) && { etag: download.headers.get('etag'), url: download.url };
			if (upgrade && upgrade.etag && upgrade.etag !== installation.etag) {
				output.appendLine(`the local app is outdated, upgrading: ${JSON.stringify({ installation, upgrade }, undefined, 2)}`);
				installation = undefined;
				if (config) {
					try {
						process.kill(config.pid);
					} catch (e) {
						output.appendLine(`failed to kill the outdated local app (pid: ${config.pid}): ${e}`);
					}
				}
				config = undefined;
			}
		}
		if (config) {
			return config;
		}
		if (installation) {
			try {
				await fs.promises.access(installation.path, fs.constants.X_OK);
				throwIfCancelled(token);
			} catch {
				installation = undefined;
			}
		}
		if (!installation) {
			if (download instanceof Error) {
				throw download;
			}
			installation = await installLocalApp(download, token);
			await context.globalState.update(installationKey, installation);
			throwIfCancelled(token);
		}
		config = await startLocalApp(gitpodHost, installation, token);
		await context.globalState.update(configKey, config);
		throwIfCancelled(token);
		return config;
	}

	async function withLocalApp<T>(gitpodHost: string, op: (client: LocalAppClient, config: LocalAppConfig) => Promise<T>): Promise<T> {
		const gitpodAuthority = vscode.Uri.parse(gitpodHost).authority;
		const configKey = 'config/' + gitpodAuthority;
		const installationKey = 'installation/' + gitpodAuthority;
		let restartAttempts = 0;
		while (restartAttempts < 5) {
			const config = await withLock(gitpodAuthority, token =>
				ensureLocalApp(gitpodHost, configKey, installationKey, token)
				, slowLockTimeout);
			const client = new LocalAppClient('http://localhost:' + config.apiPort, { transport: NodeHttpTransport() });
			try {
				const result = await op(client, config);
				return result;
			} catch (e) {
				let running: true | Error;
				try {
					process.kill(config.pid, 0);
					running = true;
				} catch (e2) {
					running = e2;
				}
				if (running === true && (e.code === grpc.Code.Unavailable || e.code === grpc.Code.Unknown)) {
					output.appendLine(`the local app (pid: ${config.pid}) is running, but the api endpoint is not ready: ${e}`);
					output.appendLine(`retying again after 1s delay...`);
					await new Promise(resolve => setTimeout(resolve, 1000));
					continue;
				}
				if (running === true) {
					throw e;
				}
				output.appendLine(`failed to access the local app: ${e}`);
				output.appendLine(`the local app (pid: ${config.pid}) is not running: ${running}`);
				output.appendLine(`restarting the local app...`);
				await withLock(gitpodAuthority, async () => {
					if (JSON.stringify(context.globalState.get<LocalAppConfig>(configKey)) === JSON.stringify(config)) {
						await context.globalState.update(configKey, undefined);
					}
				}, fastLockTimeout);
				restartAttempts++;
			}
		}
		throw new Error('failed to access the local app');
	}

	const authCompletePath = '/auth-complete';
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri: async uri => {
			if (uri.path === authCompletePath) {
				output.appendLine('auth completed');
				return;
			}
			output.appendLine('open workspace window: ' + uri.toString());
			const params: SSHConnectionParams = JSON.parse(uri.query);
			let resolvedConfig: LocalAppConfig | undefined;
			try {
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					cancellable: false,
					title: `Connecting to Gitpod workspace: ${params.workspaceId}`
				}, async () => {
					const connection = await withLocalApp(params.gitpodHost, (client, config) => {
						resolvedConfig = config;
						const request = new ResolveSSHConnectionRequest();
						request.setInstanceId(params.instanceId);
						request.setWorkspaceId(params.workspaceId);
						return new Promise<ResolveSSHConnectionResponse>((resolve, reject) =>
							client.resolveSSHConnection(request, (e, r) => r ? resolve(r) : reject(e))
						);
					});

					const config = vscode.workspace.getConfiguration('remote.SSH');
					const defaultExtensions = config.get<string[]>('defaultExtensions') || [];
					if (defaultExtensions.indexOf('gitpod.gitpod-remote-ssh') === -1) {
						defaultExtensions.unshift('gitpod.gitpod-remote-ssh');
						await config.update('defaultExtensions', defaultExtensions, vscode.ConfigurationTarget.Global);
					}
					// TODO(ak) notify a user about config file changes?
					const gitpodConfigFile = connection.getConfigFile();
					const currentConfigFile = config.get<string>('configFile');
					if (currentConfigFile === gitpodConfigFile) {
						// invalidate cached SSH targets from the current config file
						await config.update('configFile', undefined, vscode.ConfigurationTarget.Global);
					}
					await config.update('configFile', gitpodConfigFile, vscode.ConfigurationTarget.Global);
					// TODO(ak) ensure that vscode.ssh-remote is installed
					await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`vscode-remote://ssh-remote+${connection.getHost()}${uri.path || '/'}`), {
						forceNewWindow: true
					});
				});
			} catch (e) {
				const seeLogs = 'See Logs';
				vscode.window.showErrorMessage(`Failed to connect to Gitpod workspace ${params.workspaceId}: ${e}`, seeLogs).then(async result => {
					if (result !== seeLogs) {
						return;
					}
					output.show();
					if (resolvedConfig) {
						const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedConfig.logPath));
						vscode.window.showTextDocument(document);
					}
				});
				output.appendLine(`failed to open uri: ${e}`);
				throw e;
			}
		}
	}));

	if (vscode.env.remoteName === undefined || context.extension.extensionKind !== vscode.ExtensionKind.UI) {
		return;
	}

	context.subscriptions.push(vscode.commands.registerCommand('gitpod.api.autoTunnel', async (gitpodHost: string, instanceId: string, enabled: boolean) => {
		try {
			await withLocalApp(gitpodHost, client => {
				const request = new AutoTunnelRequest();
				request.setInstanceId(instanceId);
				request.setEnabled(enabled);
				return new Promise<void>((resolve, reject) =>
					client.autoTunnel(request, (e, r) => r ? resolve(undefined) : reject(e))
				);
			});
		} catch (e) {
			console.error('failed to disable auto tunneling', e);
		}
	}));
}

export function deactivate() { }
