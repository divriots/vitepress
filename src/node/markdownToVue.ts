import fs from 'fs'
import path from 'path'
import c from 'picocolors'
import matter from 'gray-matter'
import LRUCache from 'lru-cache'
import { PageData, HeadConfig, EXTERNAL_URL_RE } from './shared'
import { slash } from './utils/slash'
import { deeplyParseHeader } from './utils/parseHeader'
import { getGitTimestamp } from './utils/getGitTimestamp'
import { createMarkdownRenderer, MarkdownOptions } from './markdown/markdown'
import _debug from 'debug'
import { cleanUrlsOptions } from '../../types/shared'

const debug = _debug('vitepress:md')
const cache = new LRUCache<string, MarkdownCompileResult>({ max: 1024 })
const includesRE = /<!--\s*@include:\s*(.*?)\s*-->/g

export interface MarkdownCompileResult {
  vueSrc: string
  pageData: PageData
  deadLinks: string[]
  includes: string[]
}

export async function createMarkdownToVueRenderFn(
  srcDir: string,
  options: MarkdownOptions = {},
  pages: string[],
  userDefines: Record<string, any> | undefined,
  isBuild = false,
  base = '/',
  includeLastUpdatedData = false,
  cleanUrls: cleanUrlsOptions = 'off'
) {
  const md = await createMarkdownRenderer(srcDir, options, base, cleanUrls)

  pages = pages.map((p) => slash(p.replace(/\.md$/, '')))

  const replaceRegex = genReplaceRegexp(userDefines, isBuild)

  return async (
    src: string,
    file: string,
    publicDir: string
  ): Promise<MarkdownCompileResult> => {
    const relativePath = slash(path.relative(srcDir, file))
    const dir = path.dirname(file)

    const cached = cache.get(src)
    if (cached) {
      debug(`[cache hit] ${relativePath}`)
      return cached
    }

    const start = Date.now()

    // resolve includes
    let includes: string[] = []
    src = src.replace(includesRE, (_, m1) => {
      const includePath = path.join(dir, m1)
      const content = fs.readFileSync(includePath, 'utf-8')
      includes.push(slash(includePath))
      return content
    })

    const { content, data: frontmatter } = matter(src)

    // reset state before render
    md.__path = file
    md.__relativePath = relativePath

    const html = md.render(content)
    const data = md.__data

    // validate data.links
    const deadLinks: string[] = []
    const recordDeadLink = (url: string) => {
      console.warn(
        c.yellow(
          `\n(!) Found dead link ${c.cyan(url)} in file ${c.white(
            c.dim(file)
          )}\nIf it is intended, you can use:\n    ${c.cyan(
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
          )}`
        )
      )
      deadLinks.push(url)
    }

    if (data.links) {
      const dir = path.dirname(file)
      for (let url of data.links) {
        if (/\.(?!html|md)\w+($|\?)/i.test(url)) continue

        if (url.replace(EXTERNAL_URL_RE, '').startsWith('//localhost:')) {
          recordDeadLink(url)
          continue
        }

        url = url.replace(/[?#].*$/, '').replace(/\.(html|md)$/, '')
        if (url.endsWith('/')) url += `index`
        const resolved = decodeURIComponent(
          slash(
            url.startsWith('/')
              ? url.slice(1)
              : path.relative(srcDir, path.resolve(dir, url))
          )
        )
        if (
          !pages.includes(resolved) &&
          !fs.existsSync(path.resolve(dir, publicDir, `${resolved}.html`))
        ) {
          recordDeadLink(url)
        }
      }
    }

    const pageData: PageData = {
      title: inferTitle(frontmatter, content),
      titleTemplate: frontmatter.titleTemplate,
      description: inferDescription(frontmatter),
      frontmatter,
      headers: data.headers || [],
      relativePath
    }

    if (includeLastUpdatedData) {
      pageData.lastUpdated = await getGitTimestamp(file)
    }

    const vueSrc =
      genPageDataCode(data.hoistedTags || [], pageData, replaceRegex).join(
        '\n'
      ) +
      `\n<template><div>${replaceConstants(
        html,
        replaceRegex,
        vueTemplateBreaker
      )}</div></template>`

    debug(`[render] ${file} in ${Date.now() - start}ms.`)

    const result = {
      vueSrc,
      pageData,
      deadLinks,
      includes
    }
    cache.set(src, result)
    return result
  }
}

const scriptRE = /<\/script>/
const scriptLangTsRE = /<\s*script[^>]*\blang=['"]ts['"][^>]*/
const scriptSetupRE = /<\s*script[^>]*\bsetup\b[^>]*/
const scriptClientRE = /<\s*script[^>]*\bclient\b[^>]*/
const defaultExportRE = /((?:^|\n|;)\s*)export(\s*)default/
const namedDefaultExportRE = /((?:^|\n|;)\s*)export(.+)as(\s*)default/
const jsStringBreaker = '\u200b'
const vueTemplateBreaker = '<wbr>'

function genReplaceRegexp(
  userDefines: Record<string, any> = {},
  isBuild: boolean
): RegExp {
  // `process.env` need to be handled in both dev and build
  // @see https://github.com/vitejs/vite/blob/cad27ee8c00bbd5aeeb2be9bfb3eb164c1b77885/packages/vite/src/node/plugins/clientInjections.ts#L57-L64
  const replacements = ['process.env']
  if (isBuild) {
    replacements.push('import.meta', ...Object.keys(userDefines))
  }
  return new RegExp(
    `\\b(${replacements
      .map((key) => key.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&'))
      .join('|')})`,
    'g'
  )
}

/**
 * To avoid env variables being replaced by vite:
 * - insert `'\u200b'` char into those strings inside js string (page data)
 * - insert `<wbr>` tag into those strings inside html string (vue template)
 *
 * @see https://vitejs.dev/guide/env-and-mode.html#production-replacement
 */
function replaceConstants(str: string, replaceRegex: RegExp, breaker: string) {
  return str.replace(replaceRegex, (_) => `${_[0]}${breaker}${_.slice(1)}`)
}

function genPageDataCode(tags: string[], data: PageData, replaceRegex: RegExp) {
  const dataJson = JSON.stringify(data)
  const code = `\nexport const __pageData = JSON.parse(${JSON.stringify(
    replaceConstants(dataJson, replaceRegex, jsStringBreaker)
  )})`

  const existingScriptIndex = tags.findIndex((tag) => {
    return (
      scriptRE.test(tag) &&
      !scriptSetupRE.test(tag) &&
      !scriptClientRE.test(tag)
    )
  })

  const isUsingTS = tags.findIndex((tag) => scriptLangTsRE.test(tag)) > -1

  if (existingScriptIndex > -1) {
    const tagSrc = tags[existingScriptIndex]
    // user has <script> tag inside markdown
    // if it doesn't have export default it will error out on build
    const hasDefaultExport =
      defaultExportRE.test(tagSrc) || namedDefaultExportRE.test(tagSrc)
    tags[existingScriptIndex] = tagSrc.replace(
      scriptRE,
      code +
        (hasDefaultExport
          ? ``
          : `\nexport default {name:'${data.relativePath}'}`) +
        `</script>`
    )
  } else {
    tags.unshift(
      `<script ${isUsingTS ? 'lang="ts"' : ''}>${code}\nexport default {name:'${
        data.relativePath
      }'}</script>`
    )
  }

  return tags
}

const inferTitle = (frontmatter: Record<string, any>, content: string) => {
  if (frontmatter.title) {
    return deeplyParseHeader(frontmatter.title)
  }

  const match = content.match(/^\s*#+\s+(.*)/m)

  if (match) {
    return deeplyParseHeader(match[1].trim())
  }

  return ''
}

const inferDescription = (frontmatter: Record<string, any>) => {
  const { description, head } = frontmatter

  if (description !== undefined) {
    return description
  }

  return (head && getHeadMetaContent(head, 'description')) || ''
}

const getHeadMetaContent = (
  head: HeadConfig[],
  name: string
): string | undefined => {
  if (!head || !head.length) {
    return undefined
  }

  const meta = head.find(([tag, attrs = {}]) => {
    return tag === 'meta' && attrs.name === name && attrs.content
  })

  return meta && meta[1].content
}
