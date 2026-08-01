/**
 * 陪读的奥特曼固定是泰罗 —— 早先做过「每天自己挑一个」的页面，
 * 后来去掉了：孩子每天要先做一次无关的选择才能开始读，纯属挡路，
 * 而且挑完锁定还得多存一份状态。
 *
 * 图仍然保留全套（public/images/ultraman/），换角色只要改这一行。
 */
export const HERO_ID = 'taro'
export const HERO_NAME = '泰罗奥特曼'

export const heroImg = (id: string = HERO_ID) =>
  `${import.meta.env.BASE_URL}images/ultraman/${id}.png`
