import { describe, expect, it } from 'vitest'
import { nameCandidates, randomBlogName } from '../src/blog-name.js'

describe('nameCandidates', () => {
  const site = (parentSiteUrl: string) => nameCandidates({ parentSiteUrl })

  it('orders parent site, then title, then company email', () => {
    expect(
      nameCandidates({
        parentSiteUrl: 'https://www.ailoot.ai/',
        title: 'Ailoot Notes',
        email: 'jane@acme-corp.com',
      }),
    ).toEqual(['ailoot', 'ailoot-notes', 'acme-corp'])
  })

  it('takes the registrable label of the parent site host', () => {
    expect(site('https://www.ailoot.ai/')).toEqual(['ailoot'])
    expect(site('https://topenglighting.com')).toEqual(['topenglighting'])
    expect(site('https://shop.example.co.uk/x')).toEqual(['example'])
    expect(site('https://x.co.uk')).toEqual([]) // `x` is too short
    expect(site('https://acme.com.au')).toEqual(['acme'])
  })

  it('uses the owner label on shared hosts', () => {
    expect(site('https://acme.github.io/')).toEqual(['acme'])
    expect(site('https://acme.vercel.app')).toEqual(['acme'])
    expect(site('https://acme.netlify.app')).toEqual(['acme'])
    // Netlify deploy previews / branch deploys: `<prefix>--<site>`.
    expect(site('https://deploy-preview-12--acme-docs.netlify.app')).toEqual(['acme-docs'])
    expect(site('https://acme.pages.dev')).toEqual(['acme'])
  })

  it('skips a shared host itself', () => {
    expect(site('https://github.io')).toEqual([])
    expect(site('https://wordpress.com/')).toEqual([])
    expect(site('https://x.com/acme')).toEqual([])
  })

  it('uses the repo (else owner) on code hosts', () => {
    expect(site('https://github.com/owner/repo')).toEqual(['repo'])
    expect(site('https://github.com/owner/cool-tool.git')).toEqual(['cool-tool'])
    expect(site('https://github.com/owner')).toEqual(['owner'])
    expect(site('https://github.com/')).toEqual([])
  })

  it('skips IP and punycode hosts', () => {
    expect(site('http://192.168.1.10:3000/')).toEqual([])
    expect(site('https://пример.рф/')).toEqual([])
  })

  it('slugifies the title and drops one that slugifies to nothing or too little', () => {
    expect(nameCandidates({ title: "Jane's Café Notes" })).toEqual(['jane-s-cafe-notes'])
    expect(nameCandidates({ title: '小さなブログ' })).toEqual([])
    expect(nameCandidates({ title: 'Ж A' })).toEqual([])
    expect(nameCandidates({ title: '小さなブログ', email: 'a@acme.io' })).toEqual(['acme'])
  })

  it('caps a long title so a -N suffix still fits in 63 chars', () => {
    const [c] = nameCandidates({ title: 'word '.repeat(30) })
    expect(c.length).toBeLessThanOrEqual(60)
    expect(c).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  })

  it('uses a company email domain minus the TLD', () => {
    expect(nameCandidates({ email: 'jane@acme.io' })).toEqual(['acme'])
    expect(nameCandidates({ email: 'jane@mail.acme.co.uk' })).toEqual(['acme'])
  })

  it('skips free and agent mail providers', () => {
    for (const email of [
      'a@gmail.com',
      'a@outlook.com',
      'a@hotmail.co.uk',
      'a@yahoo.co.jp',
      'a@icloud.com',
      'a@proton.me',
      'a@qq.com',
      'a@163.com',
      'a@mail.grokbot.com',
      'a@agentmail.to',
      'a@example.com',
    ]) {
      expect(nameCandidates({ email }), email).toEqual([])
    }
  })

  it('deduplicates', () => {
    expect(nameCandidates({ parentSiteUrl: 'https://acme.io', title: 'Acme' })).toEqual(['acme'])
  })
})

describe('randomBlogName', () => {
  it('is blog- plus 5 unambiguous lowercase chars or digits', () => {
    for (let i = 0; i < 50; i++) expect(randomBlogName()).toMatch(/^blog-[a-km-np-z2-9]{5}$/)
  })
})
