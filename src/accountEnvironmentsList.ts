import { Environment } from "@azure/ms-rest-azure-env";
import { AzureAccountEnvironment } from "./azure-account.api";

export const accountAzureCloud: AzureAccountEnvironment = {...Environment.AzureCloud, azureStackApiProfile: false};
export const accountAzureChina: AzureAccountEnvironment = {...Environment.ChinaCloud, azureStackApiProfile: false};
export const accountAzureGerman: AzureAccountEnvironment = {...Environment.GermanCloud, azureStackApiProfile: false};
export const accountAzureUSGovernment: AzureAccountEnvironment = {...Environment.USGovernment, azureStackApiProfile: false}