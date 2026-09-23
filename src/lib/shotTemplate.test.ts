import { describe, expect, it } from 'vitest'
import { buildShotImagePrompt, buildVideoPrompt, parseShotTemplate } from './shotTemplate'

describe('parseShotTemplate', () => {
  it('parses one shot and its sound', () => {
    const shots = parseShotTemplate('镜头：一张横向工作台\n声音：翻页声，钥匙咔哒声')

    expect(shots).toEqual([
      {
        index: 1,
        title: '镜头 01',
        shot: '一张横向工作台',
        action: '',
        sound: '翻页声，钥匙咔哒声',
      },
    ])
  })

  it('splits several shots and keeps multiline text', () => {
    const shots = parseShotTemplate([
      '### 片段 01',
      '镜头：左侧是工作台',
      '右侧是一把钥匙',
      '声音：纸张翻开',
      '',
      '片段 02',
      '镜头: 钥匙落入陌生手里',
      '音频: 锁扣重音',
    ].join('\n'))

    expect(shots.map((shot) => shot.title)).toEqual(['片段 01', '片段 02'])
    expect(shots[0].shot).toBe('左侧是工作台\n右侧是一把钥匙')
    expect(shots[0].sound).toBe('纸张翻开')
    expect(shots[1]).toMatchObject({ shot: '钥匙落入陌生手里', sound: '锁扣重音' })
  })

  it('reads a vox block without mixing metadata into the shot', () => {
    const shots = parseShotTemplate([
      '### 片段 01',
      '原文：这就像你年轻时设计了一把钥匙。',
      '字数：16字',
      '建议时长：16 ÷ 6 = 2.7秒',
      '镜头：一张横向工作台位于画面左侧，钥匙最终落入右侧陌生手里。',
      '动作：钥匙沿轨道向右滑行。',
      '音频：翻页声之后是锁扣重音。',
    ].join('\n'))

    expect(shots).toHaveLength(1)
    expect(shots[0].shot).toBe('一张横向工作台位于画面左侧，钥匙最终落入右侧陌生手里。')
    expect(shots[0].action).toBe('钥匙沿轨道向右滑行。')
    expect(shots[0].sound).toBe('翻页声之后是锁扣重音。')
    expect(shots[0].shot).not.toContain('字数')
    expect(shots[0].shot).not.toContain('滑行')
  })

  it('accepts bold labels and same-line fields', () => {
    const shots = parseShotTemplate('**镜头：**桌子上的钥匙。声音：金属碰撞')

    expect(shots).toEqual([
      {
        index: 1,
        title: '镜头 01',
        shot: '桌子上的钥匙。',
        action: '',
        sound: '金属碰撞',
      },
    ])
  })

  it('starts a new shot when 镜头 repeats without a heading', () => {
    const shots = parseShotTemplate('镜头：第一张\n声音：风\n镜头：第二张')

    expect(shots.map((shot) => shot.shot)).toEqual(['第一张', '第二张'])
    expect(shots[0].sound).toBe('风')
    expect(shots[1].sound).toBe('')
  })

  it('uses unlabeled text as a single shot and ignores sound-only text', () => {
    expect(parseShotTemplate('  只写了画面，没有字段  ')).toEqual([
      { index: 1, title: '镜头 01', shot: '只写了画面，没有字段', action: '', sound: '' },
    ])
    expect(parseShotTemplate('声音：只有风声')).toEqual([])
    expect(parseShotTemplate('   ')).toEqual([])
  })
})

describe('buildVideoPrompt', () => {
  it('joins the template action and audio', () => {
    expect(buildVideoPrompt(' 河流依次亮起 ', '低频脉冲')).toBe('动作：河流依次亮起\n音频：低频脉冲')
    expect(buildVideoPrompt('', '  ')).toBe('')
    expect(buildVideoPrompt(' 河流依次亮起 ', '低频脉冲', '  保持画面风格一致  ')).toBe('保持画面风格一致\n动作：河流依次亮起\n音频：低频脉冲')
    expect(buildVideoPrompt('', '', '  不要字幕  ')).toBe('不要字幕')
  })
})

describe('buildShotImagePrompt', () => {
  it('adds a style instruction only when style images exist', () => {
    expect(buildShotImagePrompt('  工作台上的钥匙  ', false)).toBe('工作台上的钥匙')
    expect(buildShotImagePrompt('工作台上的钥匙', true)).toContain('样式参考')
    expect(buildShotImagePrompt('工作台上的钥匙', true)).toContain('工作台上的钥匙')
    expect(buildShotImagePrompt('工作台上的钥匙', true)).not.toContain('声音')
  })

  it('puts the shared prompt before every shot', () => {
    const prompt = buildShotImagePrompt('地图上的四座城市', true, '  16:9 横屏，不要画面文字  ')
    const sharedAt = prompt.indexOf('16:9 横屏，不要画面文字')
    const shotAt = prompt.indexOf('地图上的四座城市')
    expect(sharedAt).toBeGreaterThan(-1)
    expect(shotAt).toBeGreaterThan(sharedAt)
    expect(buildShotImagePrompt('地图上的四座城市', false, '   ')).toBe('地图上的四座城市')
  })
})
