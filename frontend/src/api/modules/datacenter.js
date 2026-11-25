import request from '../request'

export const getTwinViewerStatus = () => request.get('/datacenter/twin/status/')
export const listTwinProjects = (params) => request.get('/datacenter/twin/projects/', { params })
export const uploadTwinProject = (formData) => request.post('/datacenter/twin/projects/', formData)
/** 覆盖保存：payload 必须带 base_version，版本不一致后端返回 409。 */
export const updateTwinProject = (id, payload) => request.put(`/datacenter/twin/projects/${id}/`, payload)
/** 只改名称/说明：不递增版本、不写快照。 */
export const patchTwinProject = (id, data) => request.patch(`/datacenter/twin/projects/${id}/`, data)
export const deleteTwinProject = (id) => request.delete(`/datacenter/twin/projects/${id}/`)
export const fetchTwinProjectContent = (id) => request.get(`/datacenter/twin/projects/${id}/content/`, {
  responseType: 'text',
  transformResponse: [(data) => data],
})

/** 机柜实时状态（服务端聚合，前端只按状态着色）。 */
export const getTwinLive = (id) => request.get(`/datacenter/twin/projects/${id}/live/`)
/** 设计器绑定下拉：只含 id/name/location/status。 */
export const listTwinMonitorTargets = () => request.get('/datacenter/twin/monitor-targets/')
export const listTwinVersions = (id) => request.get(`/datacenter/twin/projects/${id}/versions/`)
export const fetchTwinVersionContent = (id, version) => request.get(
  `/datacenter/twin/projects/${id}/versions/${version}/content/`,
  { responseType: 'text', transformResponse: [(data) => data] },
)
export const rollbackTwinProject = (id, version) => request.post(
  `/datacenter/twin/projects/${id}/rollback/`, { version },
)

/* 机柜布设：方案内容 + 乐观锁 + 快照，口径与三维机房项目库一致。 */
export const listRackProjects = (params) => request.get('/datacenter/rack/projects/', { params })
export const createRackProject = (payload) => request.post('/datacenter/rack/projects/', payload)
export const updateRackProject = (id, payload) => request.put(`/datacenter/rack/projects/${id}/`, payload)
export const patchRackProject = (id, data) => request.patch(`/datacenter/rack/projects/${id}/`, data)
export const deleteRackProject = (id) => request.delete(`/datacenter/rack/projects/${id}/`)
export const fetchRackProjectContent = (id) => request.get(`/datacenter/rack/projects/${id}/content/`, {
  responseType: 'text',
  transformResponse: [(data) => data],
})
export const listRackVersions = (id) => request.get(`/datacenter/rack/projects/${id}/versions/`)
export const fetchRackVersionContent = (id, version) => request.get(
  `/datacenter/rack/projects/${id}/versions/${version}/content/`,
  { responseType: 'text', transformResponse: [(data) => data] },
)
export const rollbackRackProject = (id, version) => request.post(
  `/datacenter/rack/projects/${id}/rollback/`, { version },
)
