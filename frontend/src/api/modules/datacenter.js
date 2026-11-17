import request from '../request'

export const getTwinViewerStatus = () => request.get('/datacenter/twin/status/')
export const listTwinProjects = (params) => request.get('/datacenter/twin/projects/', { params })
export const uploadTwinProject = (formData) => request.post('/datacenter/twin/projects/', formData)
export const deleteTwinProject = (id) => request.delete(`/datacenter/twin/projects/${id}/`)
export const fetchTwinProjectContent = (id) => request.get(`/datacenter/twin/projects/${id}/content/`, {
  responseType: 'text',
  transformResponse: [(data) => data],
})
