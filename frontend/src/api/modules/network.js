import request from '../request'

export const getNetworkOverview = () => request.get('/network/overview/')

export const listNetworkDevices = (params) => request.get('/network/devices/', { params })
export const getNetworkDevice = (id) => request.get(`/network/devices/${id}/`)
export const createNetworkDevice = (data) => request.post('/network/devices/', data)
export const updateNetworkDevice = (id, data) => request.put(`/network/devices/${id}/`, data)
export const patchNetworkDevice = (id, data) => request.patch(`/network/devices/${id}/`, data)
export const deleteNetworkDevice = (id) => request.delete(`/network/devices/${id}/`)
export const testNetworkDevice = (id) => request.post(`/network/devices/${id}/test/`)
export const pollNetworkDevice = (id) => request.post(`/network/devices/${id}/poll/`)
export const getDeviceInterfaces = (id, params) => request.get(`/network/devices/${id}/interfaces/`, { params })
export const getDeviceMetrics = (id, params) => request.get(`/network/devices/${id}/metrics/`, { params })

export const listSnmpCredentials = (params) => request.get('/network/credentials/', { params })
export const createSnmpCredential = (data) => request.post('/network/credentials/', data)
export const updateSnmpCredential = (id, data) => request.put(`/network/credentials/${id}/`, data)
export const patchSnmpCredential = (id, data) => request.patch(`/network/credentials/${id}/`, data)
export const deleteSnmpCredential = (id) => request.delete(`/network/credentials/${id}/`)

export const listNetworkInterfaces = (params) => request.get('/network/interfaces/', { params })
export const getInterfaceMetrics = (id, params) => request.get(`/network/interfaces/${id}/metrics/`, { params })

export const listNetworkAlertRules = (params) => request.get('/network/alert-rules/', { params })
export const createNetworkAlertRule = (data) => request.post('/network/alert-rules/', data)
export const updateNetworkAlertRule = (id, data) => request.put(`/network/alert-rules/${id}/`, data)
export const patchNetworkAlertRule = (id, data) => request.patch(`/network/alert-rules/${id}/`, data)
export const deleteNetworkAlertRule = (id) => request.delete(`/network/alert-rules/${id}/`)

export const listNetworkAlerts = (params) => request.get('/network/alerts/', { params })
export const acknowledgeNetworkAlert = (id) => request.post(`/network/alerts/${id}/acknowledge/`)