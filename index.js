#!/usr/bin/env node

const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const path = require('path');
const cors = require('cors');
const CryptoJS = require('crypto-js');

// 默认服务器配置
const SERVER_DEFAULT_CONFIG = {
    port: 6058,
    host: '127.0.0.1',
    open: false,
}

// 检查配置文件是否存在
const ConfigPath = path.join(__dirname, './config.json');
function checkConfigIsExist() {
    if (!fs.existsSync(ConfigPath)) {
        fs.writeFileSync(ConfigPath, JSON.stringify(SERVER_DEFAULT_CONFIG, null, 4));
        console.log('服务器配置文件不存在，已自动创建');
        checkConfigIsExist();
    } else {
        return true;
    }
}
checkConfigIsExist();

// 读取配置文件
const config = JSON.parse(fs.readFileSync(ConfigPath, 'utf-8'));

// 创建服务器
const app = express();
app.use(cors(), express.json());

// 初始化数据库
const DbPath = path.join(__dirname, 'database.db');
async function initDatabase() {
    return new Promise((resolve, reject) => {
        // 创建数据库
        const db = new sqlite3.Database(DbPath);
        db.serialize(() => {
            // 用户表配置
            const userTableConfig = {
                uid: 'INTEGER PRIMARY KEY AUTOINCREMENT',
                name: 'TEXT',
                password: 'TEXT',
                level: 'NUMBER',
                token: 'TEXT',
            }
            // 课程节时配置
            // @CID: 为配置标识(由组件以任意方式自动生成)
            // @CCID: 为节时标识(后端校验生成)
            // @UID: 与用户token关联
            const classDurationConfig = {
                uid: 'TEXT',
                cid: 'TEXT',
                ccid: 'TEXT',
                duraname: 'TEXT',
                num: 'NUMBER',
                start: 'NUMBER',
                end: 'NUMBER',
            }
            // 学期配置
            // @UID: 与用户token关联
            // @CID: 学期标识(由组件以任意方式自动生成)
            // @CCID: 与节时表的CID对应 指向使用的节时配置
            const termTableConfig = {
                uid: 'TEXT',
                cid: 'TEXT',
                ccid: 'TEXT',
                firstschool: 'TEXT',
                secondscchool: 'TEXT',
                class: 'NUMBER',
                weeknum: 'NUMBER',
                start: 'NUMBER',
                end: 'NUMBER',
            }
            // 课程表配置 (UID与主表用户token关联,CID与学期表CID关联代表学期,CCID为课程标识,REFC为节时标识需与节时表CCID对应)
            const classTableConfig = {
                uid: 'TEXT',
                cid: 'TEXT',
                ccid: 'TEXT',
                tablename: 'TEXT',
                classname: 'TEXT',
                week: 'TEXT',
                weekday: 'TEXT',
                refc: 'TEXT',
                name: 'TEXT',
                teacher: 'TEXT',
                class: 'TEXT',
                location: 'TEXT',
            }
            const allTableConfig = {
                USER: userTableConfig,
                CLASS_DURATION: classDurationConfig,
                TERM: termTableConfig,
                CLASS: classTableConfig,
            }
            // 检查表是否存在
            const tableCreationPromises = [];
            for (const table in allTableConfig) {
                const tableConfig = allTableConfig[table];
                const tableColumns = Object.keys(tableConfig).map(key => `${key} ${tableConfig[key]}`).join(', ');
                const createTablePromise = new Promise((tableResolve, tableReject) => {
                    db.run(`CREATE TABLE IF NOT EXISTS ${table} (${tableColumns})`, (err) => {
                        if (err) {
                            tableReject(err);
                        } else {
                            tableResolve();
                        }
                    });
                });
                tableCreationPromises.push(createTablePromise);
            }
            Promise.all(tableCreationPromises
            ).then(() => {
                db.close();
                resolve();
            }).catch((err) => {
                db.close();
                reject(err);
            });
        });
    });
}

// 服务器路由
const staticPath = path.join(__dirname, './static/');
app.use(express.static(staticPath));

// token生成
function createToken(name, password, level) {
    const path = name + level + password;
    const token = CryptoJS.MD5(path).toString();
    return token;
}

// 生成CID
async function createCID(utoken) {
    return new Promise((resolve) => {
        const randomStr = Math.random().toString(36).substr(2);
        const CID = CryptoJS.MD5(utoken + randomStr).toString();
        resolve(CID);
    });
}

// 生成CLSS_DURATION的CCID
async function createClassDurationCCID(utoken, cid, name, num, start, end) {
    return new Promise((resolve) => {
        resolve(CryptoJS.MD5(name + start + cid + utoken + end + num).toString());
    });
}

// 生成CLASS的CCID
async function createClassCCID(utoken, cid, for_duration, week, weekday, classTime) {
    return new Promise((resolve) => {
        resolve(CryptoJS.MD5(for_duration + utoken + week + cid + weekday + classTime).toString());
    })
}

// 创建用户
function newUser(name, password, level) {
    return new Promise((resolve, reject) => {
        // 连接数据库
        const db = new sqlite3.Database(DbPath);
        // 密码加密 AES - 256 + 大写MD5
        const crypwd = CryptoJS.MD5(password).toString();
        // 生成token MD5加密(name+level)
        const token = createToken(name, crypwd, level);
        // 查询用户表是否存在该用户 索引name
        db.get(`SELECT * FROM USER WHERE name = ?`, [name], (err, row) => {
            if (err) {
                db.close();
                reject(err);
            } else {
                if (!row) {
                    // 用户不存在
                    db.run(`INSERT INTO USER (name, password, level, token) VALUES (?, ?, ?, ?)`, [name, crypwd, level, token], (err) => {
                        db.close();
                        if (err) {
                            reject(err);
                        } else {
                            console.log(`创建用户:`);
                            console.log(`Token: ${token}`);
                            console.log(`用户名: ${name}`);
                            console.log(`密码: ${crypwd}`);
                            console.log(`等级: ${level}`);
                            resolve(true);
                        }
                    });
                } else {
                    db.close();
                    resolve(false);
                }
            }
        });
    });
}

// 创建课程节时
async function newClassDuration(utoken, cid, name, num, start, end) {
    const db = new sqlite3.Database(DbPath);
    try {
        // 查询用户表是否存在该用户 索引token
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM USER WHERE token = ?`, [utoken], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        // 若用户不存在，输出错误信息并返回 false
        if (!user) {
            console.error('该用户不存在');
            return false;
        }

        // 生成 CCID
        const CCID = await createClassDurationCCID(utoken, cid, name , num, start, end);
        // 检查该 CCID 是否已经存在于 CLASS_DURATION 表中
        const existingRecord = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM CLASS_DURATION WHERE ccid = ?`, [CCID], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        // 如果 CCID 已存在，输出提示信息并返回 false
        if (existingRecord) {
            return false;
        }

        // 如果 CCID 不存在，则插入数据到数据库
        await new Promise((resolve, reject) => {
            db.run(`INSERT INTO CLASS_DURATION (ccid, cid, uid, duraname, num, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)`, [CCID, cid, utoken, name, num, start, end], (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
        return true;
    } catch (err) {
        return false;
    } finally {
        db.close();
    }
}

// 创建课程
async function newClass(utoken, cid, tableName, className, for_duration, week, weekday, classTime, location, teacher) {
    const returnError = () => {
        return {
            status: '400',
            message: '请求参数错误'
        }
    }
    // 检查必要字段是否为空
    // utoken,cid,for_duration,week,weekday,classTime(refc)
    if (!utoken || !cid || !for_duration || !week || !weekday || !classTime) {
        const needParam = ['utoken', 'cid', 'for_duration', 'week', 'weekday', 'classTime'];
        // 检查哪些字段为空
        const missingParam = needParam.filter(param => !req.query[param]);
        // 返回错误信息
        return {
            status: '204',
            message: `缺少必要参数: ${missingParam.join(', ')}`
        }
    } else if (utoken && cid && for_duration && week && weekday && classTime) {
        // 检查有无课表名称(className)字段
        // 若为空值则使用CID作为课表名称
        let FtableName, FclassName;
        if (!tableName) {
            FtableName = cid;
        } else if (tableName) {
            // 若不为空值则使用tableName作为课表名称
            FtableName = tableName;
        } else {
            return returnError();
        }
        // 检查有无课程名称(className)字段
        // 若为空值则用未知课程代替
        if (!className) {
            FclassName = '未知课程';
        } else if (className) {
            FclassName = className;
        } else {
            return returnError();
        }
        // 对所有字段进行处理
        const db = new sqlite3.Database(DbPath);
        try {
            // 查询用户表是否存在该用户 索引token
            const user = await new Promise((resolve, reject) => {
                db.get(`SELECT * FROM USER WHERE token = ?`, [utoken], (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                });
            })
            // 若用户不存在，输出错误信息并返回 false
            if (!user) {
                console.error('该用户不存在');
                return false;
            } else if (user) {
                // 若用户存在，则查询TERM表是否存在该学期 索引cid
                const result = await new Promise((resolve, reject) => {
                    db.get(`SELECT * FROM TERM WHERE cid = ?`, [cid], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(row);
                        }
                    });
                });
            } else {
                return returnError();
            }
        } catch (err) {
            console.error(err.message);
            return false;
        }
    } else {
        return returnError();
    }
}

// 启动服务器并初始化数据库
async function startServer() {
    try {
        await initDatabase();
        // 这里可以调用创建用户的函数
        newUser('admin', 'admin', 0);
        app.listen(config.port, config.host, () => {
            console.log(`ClassTab-ICS`);
            console.log(`后端服务器已启动`);
            console.log(``);
            console.log(`http://${config.host}:${config.port}`);
            console.log(``);
            if (config.open) {
                require('opn')(`http://${config.host}:${config.port}`);
            }
        });
    } catch (error) {
        console.error('服务器启动失败', error);
    }
}
startServer();

// 初始化接口
app.get('/', (req, res) => { })

// 登录接口
// @param {string} uname 用户名
// @param {string} pwd 密码
app.get('/login/verify', (req, res) => {
    const reqUname = req.query.uname;
    const cryptoPwd = CryptoJS.MD5(req.query.pwd).toString();
    // 验证器
    function verify(reqUname, cryptoPwd) {
        // 连接数据库
        const db = new sqlite3.Database(DbPath);
        // console.log(reqCryToken);
        // 查询用户表是否存在该用户 索引name
        db.get(`SELECT * FROM USER WHERE name = ?`, [reqUname], (err, row) => {
            if (err) {
                // 错误处理
                console.log(err.message);
            } else {
                if (row) {
                    // 用户存在
                    // 验证密码
                    if (row.password === cryptoPwd) {
                        const level = row.level;
                        const reqCryToken = createToken(reqUname, cryptoPwd, level);
                        if (reqCryToken === row.token) {
                            res.send({
                                status: 200,
                                message: '登录成功',
                                userinfo: {
                                    name: row.name,
                                    level: row.level,
                                    token: row.token
                                }
                            });
                        } else if (reqCryToken !== row.token) {
                            res.send({ status: 205, message: '拒绝' });
                        } else {
                            res.send({ status: 500 });
                        }
                    } else if (row.password !== cryptoPwd) {
                        res.send({
                            status: 204,
                            message: '密码错误',
                        });
                    }
                } else if (!row) {
                    // 用户不存在
                    res.send({
                        status: 404,
                        message: '用户不存在',
                    });
                } else {
                    res.send({ status: 500 })
                }
            }
        });
    }
    // 验证
    if (!reqUname || !cryptoPwd) {
        res.send({
            status: 401,
            message: '用户名或密码不能为空'
        });
    } else if (reqUname && cryptoPwd) {
        verify(reqUname, cryptoPwd);
    } else {
        res.send({
            status: 500,
            message: '服务器错误'
        });
    }
});

// 注册接口
// @params {string} uname 用户名
// @params {string} pwd 密码
app.get('/login/create', async (req, res) => {
    const name = req.query.uname;
    const crypwd = CryptoJS.MD5(req.query.pwd).toString();
    // 校验用户名密码是否为空
    if (!name || !crypwd) {
        res.send({
            status: 401,
            message: '用户名或密码不能为空'
        });
    } else if (name && crypwd) {
        try {
            const newU = await newUser(name, req.query.pwd, 1);
            if (newU) {
                res.send({
                    status: 200,
                    message: '用户创建成功',
                });
            } else {
                res.send({
                    status: 201,
                    message: '用户已存在'
                });
            }
        } catch (error) {
            console.log(error);
            res.send({
                status: 500,
                message: '服务器错误'
            });
        }
    }
});

// API列表接口
const list = [
    {
        name: '登录',
        url: '/login/verify',
        method: 'GET',
        params: {
            uname: '用户名',
            pwd: '密码'
        }
    },
    {
        name: '注册',
        url: '/login/create',
        method: 'GET',
        params: {
            uname: '用户名',
            pwd: '密码'
        }
    }, {
        name: '获取课程表',
        url: '/class/table/getlist',
        method: 'GET',
        params: {
            utoken: '用户token'
        }
    }, {
        name: '添加课程节时配置',
        url: '/class/duration/add',
        method: 'POST'
    }, {
        name: '获取课程节时配置',
        url: '/class/duration/get',
        method: 'GET'
    }
]
app.get('/api/getlist', (req, res) => {
    res.send({
        status: 200,
        message: '获取成功',
        list: list
    });
})

// 获取用户课程表接口
// @params {string} utoken 用户token
app.get('/class/getlist', async (req, res) => {
    const reqToken = req.query.utoken;
    // 若参数不为空
    if (reqToken) {
        // 连接数据库 表: CLASS 键: uid
        const db = new sqlite3.Database(DbPath);
        db.all(`SELECT * FROM CLASS WHERE uid = ?`, [reqToken], (err, row) => {
            if (err) {
                console.log(err);
                res.send({
                    status: 500,
                    message: '服务器错误'
                })
            } else if (row) {
                // 返回符合uid的所有课程表
                res.send({
                    status: 200,
                    message: '获取成功',
                    data: {
                        classlist: row
                    }
                })
            } else if (!row) {
                res.send({
                    status: 401,
                    message: '该用户暂未创建课程表'
                })
            } else {
                res.send({
                    status: 500,
                    message: '服务器错误'
                })
            }
        })
    } else if (!reqToken) {
        res.send({
            status: 401,
            message: '参数不可为空'
        })
    } else {
        res.send({
            status: 500,
            message: '服务器错误'
        })
    }
})

// 添加课程节时配置接口
// @params {string} uid 用户token
app.post('/class/duration/add', async (req, res) => {

    const uid = req.body.uid
    const cid = req.body.cid
    const durationName = req.body.name
    const duration = req.body.data

    // 检查关键参数是否为空
    if (uid && cid && duration) {

        // 检查durationName是否为空
        if (!durationName) {
            // 若为空则使用CID作为名称
            durationName = cid
        }

        try {
            // 使用 Promise.all 并行处理所有的 newClassDuration 调用
            let allSuccess = true;
            for (let i = 0; i < duration.length; i++) {
                const num = duration[i].index;
                const start = duration[i].startTime;
                const end = duration[i].endTime;

                const result = await newClassDuration(uid, cid, durationName, num, start, end);
                if (!result) {
                    allSuccess = false;
                    // 若不需要继续尝试后续添加操作，可直接跳出循环
                    break;
                }
            }

            if (allSuccess) {
                res.send({
                    status: 200,
                    message: '添加成功'
                });
            } else {
                res.send({
                    status: 405,
                    message: '添加失败'
                });
            }
        } catch (error) {
            // 处理异步操作中可能出现的错误
            res.status(500).send({
                status: 500,
                message: '服务器错误',
                error: error.message
            });
        }
    } else if (!uid || !cid || !duration) {
        res.send({
            status: 401,
            message: '参数不可为空'
        })
    } else {
        res.send({
            status: 500,
            message: '服务器错误'
        })
    }
})

// 查询课程节时配置接口
// @params {string} uid 用户token
app.get('/class/duration/get', async (req, res) => {
    const reqToken = req.query.uid;
    // 若参数不为空
    if (reqToken) {
        // 连接数据库
        const db = new sqlite3.Database(DbPath);
        
        // 检查用户是否存在 表: USER 键: token
        db.all(`SELECT * FROM CLASS_DURATION WHERE uid = ?`, [reqToken], (err, row) => {
            if (err) {
                res.send({
                    status: 500,
                    message: '服务器错误'
                })
            } else if (row) {
                // 若用户存在
                // 查询课程节时配置表对应用户下的所有cid 表: CLASS_DURATION 键: cid
                db.all(`SELECT * FROM CLASS_DURATION WHERE uid = ?`, [reqToken], (err, row) => {
                    if (err) {
                        res.send({
                            status: 500,
                            message: '服务器错误'
                        })
                    } else if (row) {
                        res.send({
                            status: 200,
                            message: '查询成功',
                            data: row
                        })
                    } else if(!row) {
                        res.send({
                            status: 204,
                            message: '该用户还未创建课程节时配置'
                        })
                    }else {
                        res.send({
                            status: 500,
                            message: '服务器错误'
                        })
                    }
                })
            } else if (!row) {
                res.send({
                    status: 404,
                    message: '该用户不存在'
                })
            } else {
                res.send({
                    status: 500,
                    message: '服务器错误'
                })
            }
        })
    } else if (!reqToken) {
        res.send({
            status: 401,
            message: '参数不可为空'
        })
    } else {
        res.send({
            status: 500,
            message: '服务器错误'
        })
    }
})
                