const config = require('config');
const settings = config.get('settings');
const spawn = require('child_process');
const ssh = spawn.exec(settings.baseCommand || 'pilight-receive');

ssh.stderr.on('data', (err) => {
  error = true;
  attempts += 1;
});

const fs = require('fs');
const moment = require('moment');
const MongoClient = require('mongodb').MongoClient;

const isDev = process.env.NODE_ENV === 'development';
const saveMode = config.has('settings.saveMode') ? config.get('settings.saveMode') : 'file';

let message, message2 = null;

const devices = config.get('devices');
const validDevices = devices.map((device) => { return device.deviceId });
let deviceToSystemMapper = {};

devices.forEach((device) => {
  deviceToSystemMapper[device.deviceId] = device.systemId;
});

ssh.on('error', (err) => {
  console.log('WARNING: pilight-receive was not found on this machine. If you are not in dev mode, please check this!');
  if (!isDev) {
    process.exit(0);
  }
} );

if (isDev) {
  message = require('./data/message');
  message2 = require('./data/message2');
}

let messages = '';

ssh.stdout.on('data', (data) => {
  messages += data.toString().replace(/(\n|\t|\r)/gm, '');
});

setInterval(() => {
  processMessages();
}, settings.get('saveInterval'));

let processMessages = () => {
  let completed = messages.split('}{');
  let dataToProcess = {};

  completed.forEach((message, key) => {
    if ('{' !== message[0]) message = '{' + message;
    if ('}' !== message[message.length-1]) message = message + '}';
    
    let data = null;
    
    try {
      data = JSON.parse(message);
    }  
    catch(e) {
      message = message.substr(0, message.length - 2);
    }  

        
    completed[key] = false;

    if (!data || !data.message) {
        return;
    }

    if (deviceToSystemMapper[data.message.id]) {
      data.message.id = parseInt(deviceToSystemMapper[data.message.id]);
    }
    else {
      data.message.id = `unbekannt (id: ${data.message.id || undefined})`;
    }
  
    if (!dataToProcess[data.message.id]) {
      dataToProcess[data.message.id] = [];
    }

    dataToProcess[data.message.id].push(data);
  });

  Object.keys(dataToProcess).forEach((id) => {
    let data = dataToProcess[id].pop();
    
    id = parseInt(id);

    if ('file' === saveMode) {
      saveToFile(data);
    }
    else {
      if (Number.isNaN(id)) {
        return;
      }
      saveToDatabase(data.message, (err, db) => {
        if (err) {
          console.log(err);
        }

        if (db) {
          db.close();
        }
      });   
    }
  })

  completed = completed.filter((elem) => { return !!elem });
  
  messages = completed.join('}{');
};

let generateSaveMessage = function (id, temperature, humidity, battery) {
    return moment().format() + ' ' + id + ' ' + temperature + ' ' + humidity + ' ' + battery + "\n";
}

let generateWeatherObject = function (data) {
  return {
    time: moment().format(),
    id: data.id, 
    temperature: data.temperature, 
    humidity: data.humidity, 
    battery: data.battery
  };
}

let saveToFile = function (data, callback) {
  let fileData = generateSaveMessage(data.message.id, data.message.temperature, data.message.humidity, data.message.battery);
  callback = callback || (()=>{});

  fs.appendFile('data/db.txt', fileData, function (err) {
      if (err) { console.log(err); throw err };
  });
}

let saveToDatabase = function (data, callback) {
  callback = callback || (()=>{});
  data = generateWeatherObject(data);

  MongoClient.connect(getDatabaseUrl(config.get('database')), (err, db) => {
    if (err) { 
      return callback(err, null);
    };

    let weatherCollection = db.collection('weather');
    weatherCollection.updateOne({id: data.id}, {$set: data}, {upsert: true}, (err, records) => {
      if (err) { 
        return callback(err, db); 
      };

      return callback(null, db);
    });
  });
}

let getDatabaseUrl = (config) => {
  return [
    'mongodb://', config.user, ':', config.password, '@', config.host, ':', config.port, '/', config.database
  ].join('');
}

process.on('uncaughtException', () => { ssh.kill(); process.exit(); });
process.on('exit', () => { ssh.kill(); process.exit(); });
process.on('SIGTERM', () => { ssh.kill(); process.exit(); });
process.on('SIGINT', () => { ssh.kill(); process.exit(); });