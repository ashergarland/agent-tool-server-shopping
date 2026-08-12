using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param deployApp = false
param containerImage = 'replace.invalid/agent-tool-server-shopping:replace-me'
param mutationsEnabled = false
param minReplicas = 0
param maxReplicas = 3
