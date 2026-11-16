import request from '../request'

export const getPlanningStatus = () => request.get('/planning-status')
export const getPlanningScene = () => request.get('/planning/api/scene')