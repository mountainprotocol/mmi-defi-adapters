import { promises as fs } from 'node:fs'
import path from 'node:path'
import chalk from 'chalk'
import { Command } from 'commander'
import partition from 'lodash/partition'
import { parse, print, types, visit } from 'recast'
import { Protocol } from '../adapters/protocols'
import { supportedProtocols } from '../adapters/supportedProtocols'
import { AdaptersController } from '../core/adaptersController'
import { Chain, ChainName } from '../core/constants/chains'
import { IMetadataBuilder } from '../core/decorators/cacheToFile'
import {
  NotImplementedError,
  ProviderMissingError,
} from '../core/errors/errors'
import { CustomJsonRpcProvider } from '../core/provider/CustomJsonRpcProvider'
import { pascalCase } from '../core/utils/caseConversion'
import { logger } from '../core/utils/logger'
import { writeAndLintFile } from '../core/utils/writeAndLintFile'
import { Json } from '../types/json'
import { getMetadataInvalidAddresses } from './addressValidation'
import { multiChainFilter, multiProtocolFilter } from './commandFilters'
import { sortEntries } from './utils/sortEntries'
import n = types.namedTypes
import b = types.builders

export function buildMetadata(
  program: Command,
  chainProviders: Record<Chain, CustomJsonRpcProvider>,
  adaptersController: AdaptersController,
) {
  program
    .command('build-metadata')
    .option(
      '-p, --protocols <protocols>',
      'comma-separated protocols filter (e.g. stargate,aave-v2)',
    )
    .option(
      '-c, --chains <chains>',
      'comma-separated chains filter (e.g. ethereum,arbitrum,linea)',
    )
    .showHelpAfterError()
    .action(async ({ protocols, chains }) => {
      const filterProtocolIds = multiProtocolFilter(protocols)
      const filterChainIds = multiChainFilter(chains)

      for (const [protocolIdKey, supportedChains] of Object.entries(
        supportedProtocols,
      )) {
        const protocolId = protocolIdKey as Protocol
        if (filterProtocolIds && !filterProtocolIds.includes(protocolId)) {
          continue
        }

        for (const [chainIdKey, _] of Object.entries(supportedChains)) {
          const chainId = +chainIdKey as Chain
          if (filterChainIds && !filterChainIds.includes(chainId)) {
            continue
          }

          const provider = chainProviders[chainId]

          if (!provider) {
            logger.error({ chainId }, 'No provider found for chain')
            throw new ProviderMissingError(chainId)
          }

          const chainProtocolAdapters =
            adaptersController.fetchChainProtocolAdapters(chainId, protocolId)

          for (const [_, adapter] of chainProtocolAdapters) {
            let metadataDetails:
              | {
                  metadata: Json
                  fileDetails: {
                    protocolId: Protocol
                    productId: string
                    chainId: Chain
                    fileKey: string
                  }
                }
              | undefined

            if (adapter.adapterSettings.version === 2) {
              metadataDetails = (await adapter
                .getProtocolTokens(true)
                .catch((e) => {
                  if (!(e instanceof NotImplementedError)) {
                    throw e
                  }

                  return undefined
                })) as
                | {
                    metadata: Json
                    fileDetails: {
                      protocolId: Protocol
                      productId: string
                      chainId: Chain
                      fileKey: string
                    }
                  }
                | undefined
            }

            if (isIMetadataBuilder(adapter)) {
              metadataDetails = (await adapter
                .buildMetadata(true)
                .catch((e) => {
                  if (!(e instanceof NotImplementedError)) {
                    throw e
                  }

                  return undefined
                })) as
                | {
                    metadata: Json
                    fileDetails: {
                      protocolId: Protocol
                      productId: string
                      chainId: Chain
                      fileKey: string
                    }
                  }
                | undefined
            }

            if (!metadataDetails) {
              continue
            }

            const { metadata, fileDetails } = metadataDetails

            const invalidAddresses = getMetadataInvalidAddresses(metadata)

            if (invalidAddresses.length > 0) {
              console.error(chalk.yellow(invalidAddresses.join('\n')))

              console.error(
                chalk.red(
                  '\n * The above addresses found in the metadata file are not in checksum format.',
                ),
              )
              console.error(
                chalk.green(
                  '\n * Please ensure that addresses are in checksum format by wrapping them with getAddress from the ethers package.',
                ),
              )
              console.error(
                chalk.green(
                  '\n * Please checksum your addresses inside the buildMetadata() method.',
                ),
              )
              return
            }

            await writeMetadataToFile({
              ...fileDetails,
              metadata,
            })

            await addStaticImport(fileDetails)
          }
        }
      }
    })
}

// biome-ignore lint/suspicious/noExplicitAny: type of value is asserted in method
function isIMetadataBuilder(value: any): value is IMetadataBuilder {
  return (
    typeof value === 'object' &&
    'buildMetadata' in value &&
    typeof value['buildMetadata'] === 'function'
  )
}

async function writeMetadataToFile({
  protocolId,
  productId,
  chainId,
  fileKey,
  metadata,
}: {
  protocolId: Protocol
  productId: string
  chainId: Chain
  fileKey: string
  metadata: Json
}) {
  const newFilePath = path.resolve(
    `./packages/adapters-library/src/adapters/${protocolId}/products/${productId}/metadata/${ChainName[chainId]}.${fileKey}.json`,
  )

  await writeAndLintFile(newFilePath, JSON.stringify(metadata, null, 2))
}

async function addStaticImport({
  protocolId,
  productId,
  chainId,
  fileKey,
}: {
  protocolId: Protocol
  productId: string
  chainId: Chain
  fileKey: string
}) {
  const adapterMetadataFile = path.resolve(
    './packages/adapters-library/src/core/metadata/AdapterMetadata.ts',
  )
  const contents = await fs.readFile(adapterMetadataFile, 'utf-8')
  const ast = parse(contents, {
    parser: require('recast/parsers/typescript'),
  })

  const protocolKey = Object.keys(Protocol).find(
    (protocolKey) =>
      Protocol[protocolKey as keyof typeof Protocol] === protocolId,
  ) as keyof typeof Protocol

  const chainKey = Object.keys(Chain).find(
    (chainKey) => Chain[chainKey as keyof typeof Chain] === chainId,
  ) as keyof typeof Chain

  visit(ast, {
    visitProgram(path) {
      const programNode = path.value as n.Program

      addAdapterMetadataImport({
        programNode,
        protocolKey,
        protocolId,
        productId,
        chainKey,
        chainId,
        fileKey,
      })

      this.traverse(path)
    },
    visitVariableDeclarator(path) {
      const node = path.node
      if (!n.Identifier.check(node.id)) {
        // Skips any other declaration
        return false
      }

      if (node.id.name === 'MetadataFiles') {
        addAdapterMetadataEntry({
          metadataFilesDeclaratorNode: node,
          protocolKey,
          productId,
          chainKey,
          fileKey,
        })
      }

      this.traverse(path)
    },
  })

  await writeAndLintFile(adapterMetadataFile, print(ast).code)
}

/**
 * @description Adds a new entry to the imports for the new adapter
 *
 * @param programNode AST node for the Protocol program
 */
function addAdapterMetadataImport({
  programNode,
  protocolKey,
  protocolId,
  productId,
  chainKey,
  chainId,
  fileKey,
}: {
  programNode: n.Program
  protocolKey: keyof typeof Protocol
  protocolId: Protocol
  productId: string
  chainKey: keyof typeof Chain
  chainId: Chain
  fileKey: string
}) {
  const [importNodes, codeAfterImports] = partition(programNode.body, (node) =>
    n.ImportDeclaration.check(node),
  )

  const metadataImportEntry = importNodes.find((x) => {
    if (!n.ImportDeclaration.check(x)) {
      return false
    }

    return (
      x.specifiers![0]!.local?.name ===
      `${protocolKey}${pascalCase(productId)}${chainKey}${pascalCase(fileKey)}`
    )
  })

  if (metadataImportEntry) {
    return
  }

  const newMetadataImportEntry = buildImportAdapterMetadataEntry(
    protocolKey,
    protocolId,
    productId,
    chainKey,
    chainId,
    fileKey,
  )

  programNode.body = [
    ...importNodes,
    newMetadataImportEntry,
    ...codeAfterImports,
  ]
}

/*
import <ProtocolKey><ProductKey><ChainKey><FileKey> from '../../adapters/<protocol-id>/products/<product-id>/metadata/<chain-name>.<file-key>.json'
*/
function buildImportAdapterMetadataEntry(
  protocolKey: keyof typeof Protocol,
  protocolId: Protocol,
  productId: string,
  chainKey: keyof typeof Chain,
  chainId: Chain,
  fileKey: string,
) {
  return b.importDeclaration(
    [
      b.importDefaultSpecifier(
        b.identifier(
          `${protocolKey}${pascalCase(productId)}${chainKey}${pascalCase(
            fileKey,
          )}`,
        ),
      ),
    ],
    b.literal(
      `../../adapters/${protocolId}/products/${productId}/metadata/${ChainName[chainId]}.${fileKey}.json`,
    ),
  )
}

/**
 * @description Adds chain entries for the adapter to the supportedProtocols constant
 *
 * @param metadataFilesDeclaratorNode AST node for the supportedProtocols declarator
 */
function addAdapterMetadataEntry({
  metadataFilesDeclaratorNode,
  protocolKey,
  productId,
  chainKey,
  fileKey,
}: {
  metadataFilesDeclaratorNode: n.VariableDeclarator
  protocolKey: keyof typeof Protocol
  productId: string
  chainKey: keyof typeof Chain
  fileKey: string
}) {
  const metadataFilesNewMapNode = metadataFilesDeclaratorNode.init
  if (
    !n.NewExpression.check(metadataFilesNewMapNode) ||
    !n.ArrayExpression.check(metadataFilesNewMapNode.arguments[0])
  ) {
    throw new Error('Incorrectly typed MetadataFiles new Map expression')
  }

  const metadataEntries = metadataFilesNewMapNode.arguments[0]

  const metadataFileEntry = metadataEntries.elements.find((x) => {
    if (
      !n.ArrayExpression.check(x) ||
      x.elements.length !== 2 ||
      !n.Identifier.check(x.elements[1])
    ) {
      return false
    }

    return (
      x.elements[1].name ===
      `${protocolKey}${pascalCase(productId)}${chainKey}${pascalCase(fileKey)}`
    )
  })

  if (metadataFileEntry) {
    return
  }

  const protocolIdProp = b.objectProperty(
    b.identifier('protocolId'),
    b.memberExpression(b.identifier('Protocol'), b.identifier(protocolKey)),
  )
  const productIdProp = b.objectProperty(
    b.identifier('productId'),
    b.stringLiteral(productId),
  )
  const chainIdProp = b.objectProperty(
    b.identifier('chainId'),
    b.memberExpression(b.identifier('Chain'), b.identifier(chainKey)),
  )
  const fileKeyProp = b.objectProperty(
    b.identifier('fileKey'),
    b.stringLiteral(fileKey),
  )
  const metadataEntryKey = b.callExpression(b.identifier('metadataKey'), [
    b.objectExpression([
      protocolIdProp,
      productIdProp,
      chainIdProp,
      fileKeyProp,
    ]),
  ])
  const metadataEntryJson = b.identifier(
    `${protocolKey}${pascalCase(productId)}${chainKey}${pascalCase(fileKey)}`,
  )

  const newMetadataEntry = b.arrayExpression([
    metadataEntryKey,
    metadataEntryJson,
  ])

  metadataEntries.elements.push(newMetadataEntry)

  sortEntries(
    metadataEntries.elements,
    (entry) => ((entry as n.ArrayExpression).elements[1] as n.Identifier).name,
  )
}
