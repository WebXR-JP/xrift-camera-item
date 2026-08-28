import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three'
import type { AtlasSlot } from './canvasTexture'

export interface MergePart {
  geometry: BufferGeometry
  matrix?: Matrix4
}

const _pos = new Vector3()
const _quat = new Quaternion()
const _euler = new Euler()
const _scale = new Vector3(1, 1, 1)

/** 位置・回転（ラジアン）・スケールから行列を作る小道具 */
export const partMatrix = (
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): Matrix4 => {
  _pos.set(position[0], position[1], position[2])
  _quat.setFromEuler(_euler.set(rotation[0], rotation[1], rotation[2]))
  _scale.set(scale[0], scale[1], scale[2])
  return new Matrix4().compose(_pos, _quat, _scale)
}

/**
 * 同じマテリアルで描く小さなパーツを 1 つのジオメトリにまとめる。
 *
 * ドローンは 40 個近い小メッシュの集まりで、そのまま置くと 1 機で 40 ドローコール
 * 掛かる。三角形はどうせ 2000 枚も無いので、まとめてしまえば描画コストは
 * ほぼ消える。addons の BufferGeometryUtils は shared に載っていない（＝アイテムに
 * バンドルされてしまう）ので、必要な機能だけここに持っている。
 *
 * 渡したジオメトリはこの中で dispose する（GPU には上げずに捨てる）。
 * uv は既定で落とす（無地のマテリアルには要らない）。atlas から切り出した
 * ラベル板をまとめるときだけ keepUV を立てる。
 */
export const mergeParts = (parts: MergePart[], keepUV = false): BufferGeometry => {
  const staged: BufferGeometry[] = []
  let total = 0

  for (const part of parts) {
    const g = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone()
    if (part.matrix) g.applyMatrix4(part.matrix)
    if (!keepUV) g.deleteAttribute('uv')
    staged.push(g)
    total += g.attributes.position.count
    part.geometry.dispose()
  }

  const position = new Float32Array(total * 3)
  const normal = new Float32Array(total * 3)
  const uv = keepUV ? new Float32Array(total * 2) : null
  let offset = 0
  for (const g of staged) {
    position.set(g.attributes.position.array as Float32Array, offset * 3)
    normal.set(g.attributes.normal.array as Float32Array, offset * 3)
    if (uv) uv.set(g.attributes.uv.array as Float32Array, offset * 2)
    offset += g.attributes.position.count
    g.dispose()
  }

  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(position, 3))
  out.setAttribute('normal', new BufferAttribute(normal, 3))
  if (uv) out.setAttribute('uv', new BufferAttribute(uv, 2))
  out.computeBoundingSphere()
  return out
}

/**
 * atlas の 1 コマを貼るための板ポリ。uv をスロットの範囲に差し替える。
 * これを mergeParts(..., true) でまとめると、パネル中の文字が全部 1 メッシュになる。
 */
export const labelQuad = (
  width: number,
  height: number,
  slot: AtlasSlot,
  matrix?: Matrix4,
): BufferGeometry => {
  const g = new PlaneGeometry(width, height)
  const uv = g.attributes.uv as BufferAttribute
  // PlaneGeometry の頂点は 左上・右上・左下・右下 の順
  uv.setXY(0, slot.u0, slot.v1)
  uv.setXY(1, slot.u1, slot.v1)
  uv.setXY(2, slot.u0, slot.v0)
  uv.setXY(3, slot.u1, slot.v0)
  uv.needsUpdate = true
  if (matrix) g.applyMatrix4(matrix)
  return g
}
