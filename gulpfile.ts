/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, writeFile } from 'fs-extra';
import { join } from 'path';

declare let exports: { [key: string]: unknown };

async function cleanReadme(): Promise<void> {
    const readmePath: string = join(__dirname, 'README.md');
    let data: string = (await readFile(readmePath)).toString();
    data = data.replace(/<!-- region exclude-from-marketplace -->.*?<!-- endregion exclude-from-marketplace -->/gis, '');
    await writeFile(readmePath, data);
}

exports.cleanReadme = cleanReadme;
