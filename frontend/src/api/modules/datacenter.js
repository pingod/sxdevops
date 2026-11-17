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
