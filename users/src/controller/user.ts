import { Request, Response, NextFunction } from 'express';
import { ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import database from '../database/user';
import User from '../interfaces/user';
import account from '../interfaces/account';
import Token from '../interfaces/token';
import Login from '../interfaces/login';
import config from '../config/config';
import token from '../middleware/verify';
import amqp from 'amqplib';

const verifyAccount = (req : Request, res : Response, next : NextFunction): Promise<Response> => { return database.validateUser(req, res); };

const validateLocation = async(user: User): Promise<User> => {
    const response = await axios({
        method : 'post',
        url : 'http://localhost:3001/validatelocation',
        data : {
            user
        }
    });

    return response.data as User;


}

const register = async(req : Request, res : Response, next : NextFunction): Promise<Response> => {
    let {
        name,
        password,
        email,
        bio,
        phone_number,
        confirmPassword,
        confirmEmail, 
        location
    } = req.body
    
    const checkParameters = (user :User): boolean => {
        Object.values(user).every(value => {
            if(value === undefined) return true;
        });
        return false;
    }

    const parseNumber = (number : string) => {
        return number.replace('(', '').replace(')', '').replace('-', '');
    }

    const getMeters = (miles: number) => {
        return miles * 1609.344;
    }

    const date = new Date();

    let User: User = {
        _id : new ObjectId(),
        name : String(name).toLowerCase(),
        password : String(req.body.password),
        email : String(email).toLowerCase(),
        phone_number : parseNumber(phone_number),
        bio : String(bio),
        base_location : {
            city : String(location),
            coords : [],
            distance : getMeters(50)
        },
        follow_list : [],
        created : new Date(date.getFullYear(), date.getMonth(), date.getDate()),
        verified : false,
    };

    User = await validateLocation(User);
    User._id = new ObjectId(User._id);

    if(checkParameters(User))
        res.status(403).json({
            message : 'one or more fields are empty'
        });


    if(password !== confirmPassword && email !== confirmEmail) { 
        return res.status(401).json({
            message : 'password or email do not match!',
        });
    } else {
        if(config.regex.email.test(email) && config.regex.password.test(password) && config.regex.phone.test(phone_number)) {
            bcrypt.hash(password, 10, async (err: Error, hash: string) => {
                if (err) {
                    return res.status(401).json({
                        message: 'Could not generate hash',
                        error: err
                    });
                }
                User.password = hash;
            });
            return await database.addUser(req, res, User);
        } else {
            return res.status(500).json({
                message : 'your phone number, email, or password do not meet the required criteria'
            });
        }
    }
}

const login = async(req : Request, res : Response): Promise<Response> => {
    let login: Login = {
        username : String(req.body.username),
        password : String(req.body.password),
    };

    //role based authorization strats
    if(config.regex.email.test(login.username)) {
        if(await database.getEmail(login.username)) {
            const user = await database.getUserByEmail(login.username) as User;
            if(user !== undefined && bcrypt.compareSync(login.password, user.password)) {
                const token = jwt.sign({ id : String(user._id)}, config.server.token.secret, { expiresIn : 60 * 60 });
                req.headers['authorization'] = token;
                return res.status(200).json({
                    message : 'signed in',
                    token : token
                });
            }
        } else 
            return res.status(401).json('A wrong username or password was wrong. Please try again'); 
        
        
    } else if(config.regex.phone.test(login.username)) {

    } else {
        return res.status(401).json('A wrong username or password was wrong. Please try again');
    }
    return res.json();
}

const getAllUsers = async(req : Request, res : Response) => {
    return res.status(200).json(await database.getAllUsers());
}

const resetPassword = async(req : Request, res : Response): Promise<Response> => {
    let username = req.body || '';
    if(username === '')
        return res.status(401).json({
            message : 'the username you sent was empty'
        });
    let account = await database.getUserByEmail(username.username);
    if(account !== undefined) {
        const url = config.server.queue || 'amqp://localhost';
        const connection = await amqp.connect(url);
        const channel = await connection.createChannel();

        channel.assertQueue('reset password', {durable : false});
        let link = 'http://' + req.get('host') + '/reset?id=' + account._id;

        let options = {
            to : account.email,
            from : '',
            subject : 'reset password',
            html : 'Hello, <br> Please click the link to reset your password.<br><a href=' + link + '>Click here to reset your password</a>'
        };
        
        channel.sendToQueue('reset password', Buffer.from(JSON.stringify(options)));

        return res.status(200).json({
            message : 'please check your email to reset your password'
        })
    } else {
        return res.status(401).json({
            message : 'the username you entered does not exist'
        });
    }
}

const reset = async(req : Request, res : Response): Promise<Response> => {
    return database.resetPassword(req, res);
}

const updateUserInformation = async(req : Request, res : Response): Promise<Response> => {
    const id = String(req.query.id);
    const user = await database.getUserById(new ObjectId(id));
    if(user !== null) {
        let acc :account = {
            name : req.body.name !== undefined ? req.body.name : user.name,
            email : req.body.email !== undefined ? req.body.email : user.email,
            phone_number : req.body.phone_number !== undefined ? req.body.phone_number : user.phone_number,
            bio : req.body.bio !== undefined ? req.body.bio : user.bio,
            base_location : {
                city : req.body.city !== undefined ? req.body.city : user.base_location.city,
                distance : req.body.distance !== undefined ? req.body.distance : user.base_location.distance
            }
        };

        await database.updateAccount(id, acc);
        return res.status(200).json({
            message : 'profile was successfully updated'
        });
    }
    return res.status(500).json({
        message : 'invalid data was sent'
    });
}

const addFollower = async(req: Request, res: Response): Promise<Response> => {
    const id = new ObjectId(String(req.query.id));
    const user: Token = token.getToken(req);

    return await database.addFollower(id, user, res);
}

// removes the user from the follower list
const removeFollower = async(req: Request, res: Response): Promise<Response> => {
    const id = new ObjectId(String(req.query.id));
    const user: Token = token.getToken(req);
    return await database.removeFollower(id, user, res);
}

const getUser = async(req: Request, res: Response): Promise<Response> => {
    return res.status(200).json({ user :  await database.getUserById(new ObjectId(String(req.query.id))) });
}

export default { verifyAccount, register, login, getAllUsers, resetPassword, reset, updateUserInformation, addUser: addFollower, removeUser: removeFollower, getUser };