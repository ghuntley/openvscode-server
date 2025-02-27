/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { normalizeGitHubUrl } from 'vs/platform/issue/common/issueReporterUtil';
import { IExtensionManagementService, ILocalExtension } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionType } from 'vs/platform/extensions/common/extensions';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IProductService } from 'vs/platform/product/common/productService';
import { IWorkbenchIssueService } from 'vs/workbench/services/issue/common/issue';
import { IssueReporterData } from 'vs/platform/issue/common/issue';
import { userAgent } from 'vs/base/common/platform';

export class WebIssueService implements IWorkbenchIssueService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService
	) { }

	//TODO @TylerLeonhardt @Tyriar to implement a process explorer for the web
	async openProcessExplorer(): Promise<void> {
		console.error('openProcessExplorer is not implemented in web');
	}

	async openReporter(options: Partial<IssueReporterData>): Promise<void> {
		let repositoryUrl = this.productService.reportIssueUrl;
		let selectedExtension: ILocalExtension | undefined;
		if (options.extensionId) {
			const extensions = await this.extensionManagementService.getInstalled(ExtensionType.User);
			selectedExtension = extensions.filter(ext => ext.identifier.id === options.extensionId)[0];
			const extensionGitHubUrl = await this.getExtensionGitHubUrl(selectedExtension);
			if (extensionGitHubUrl) {
				repositoryUrl = `${extensionGitHubUrl}/issues/new`;
			}
		}

		if (repositoryUrl) {
			repositoryUrl = `${repositoryUrl}?body=${encodeURIComponent(await this.getIssueDescription(selectedExtension))}`;
			return this.openerService.open(URI.parse(repositoryUrl)).then(_ => { });
		} else {
			throw new Error(`Unable to find issue reporting url for ${options.extensionId}`);
		}
	}

	private async getExtensionGitHubUrl(extension: ILocalExtension): Promise<string> {
		let repositoryUrl = '';

		const bugsUrl = extension?.manifest.bugs?.url;
		const extensionUrl = extension?.manifest.repository?.url;

		// If given, try to match the extension's bug url
		if (bugsUrl && bugsUrl.match(/^https?:\/\/github\.com\/(.*)/)) {
			repositoryUrl = normalizeGitHubUrl(bugsUrl);
		} else if (extensionUrl && extensionUrl.match(/^https?:\/\/github\.com\/(.*)/)) {
			repositoryUrl = normalizeGitHubUrl(extensionUrl);
		}

		return repositoryUrl;
	}

	private async getIssueDescription(extension: ILocalExtension | undefined): Promise<string> {
		return `
Issue Type (Please pick one): <b>Bug | Feature request</b>

ADD ISSUE DESCRIPTION HERE

${extension?.manifest.version ? `\nExtension version: ${extension.manifest.version}` : ''}
VS Code version: ${this.productService.version}
VS Code commit: ${this.productService.commit ?? 'unknown'}
User Agent: ${userAgent?.replace(';', ',') ?? 'unknown'}
Embedder: ${this.productService.embedderIdentifier ?? 'unknown'}
<!-- generated by web issue reporter -->`;
	}
}
