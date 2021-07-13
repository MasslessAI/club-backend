import RSSParser from 'rss-parser'
import axios from 'axios'
import { toXML } from 'jstoxml'
import moment from 'moment'
import { v4 as uuidv4 } from 'uuid'
import got from 'got'
import cheerio from 'cheerio'

const IS_OFFLINE = process.env.IS_OFFLINE
const path = require('path')
const fs = require('fs')
var ffmpeg = require('fluent-ffmpeg')

const AWS = require('aws-sdk')
const TMP_PATH = '/tmp'

// setup S3
const S3_BUCKET = process.env.S3_BUCKET
const S3 = new AWS.S3(
  IS_OFFLINE && {
    s3ForcePathStyle: true,
    accessKeyId: 'S3RVER', // This specific key is required when working offline
    secretAccessKey: 'S3RVER',
    endpoint: new AWS.Endpoint('http://localhost:4569'),
    region: 'us-east-1'
  }
)

const BUCKET_BASE_URL = IS_OFFLINE
  ? `http://localhost:4569/${S3_BUCKET}`
  : `https://${S3_BUCKET}.s3.amazonaws.com`

// setup dynamodb
const { PODCAST_TABLE, EPISODE_TABLE } = process.env
const dynamoDb = new AWS.DynamoDB.DocumentClient({
  region: 'localhost',
  endpoint: 'http://localhost:8000',
  accessKeyId: 'DEFAULT_ACCESS_KEY', // needed if you don't have aws credentials at all in env
  secretAccessKey: 'DEFAULT_SECRET' // needed if you don't have aws credentials at all in env
})

const PUB_DATE_FORMAT = 'ddd, DD MMM YYYY HH:mm:ss ZZ'

// https://stackoverflow.com/questions/34909125/merge-deep-objects-and-override
const deepExtend = (destination, source) => {
  for (var property in source) {
    if (typeof source[property] === 'object' && source[property] !== null) {
      destination[property] = destination[property] || {}
      deepExtend(destination[property], source[property])
    } else {
      destination[property] = source[property]
    }
  }
}

const toRSSCompatibleJSON = json => {
  // process {itunes: {...itunesItems}}
  const handleItunes = itunesItems => {
    return Object.entries(itunesItems)
      .map(([ituneKey, ituneVal]) => {
        if (ituneKey === 'image') {
          return {
            _name: `itunes:image`,
            _attrs: {
              href: ituneVal
            }
          }
        } else if (ituneKey === 'owner') {
          return {
            'itunes:owner': {
              'itunes:name': ituneVal.name,
              'itunes:email': ituneVal.email
            }
          }
        } else if (ituneKey === 'categories' || ituneKey === 'categoriesWithSubs') {
          if (ituneKey === 'categoriesWithSubs') {
            return {
              _name: 'itunes:category',
              _attrs: {
                text: ituneVal[0].name
              },
              _content: {
                _name: 'itunes:category',
                _attrs: {
                  text: ituneVal[0].subs[0].name
                }
              }
            }
          } else {
            return {
              _name: 'itunes:category',
              _attrs: {
                text: ituneVal[0]
              }
            }
          }
        } else if (ituneKey === 'keywords') {
          return {
            [`itunes:${ituneKey}`]: ituneVal.join()
          }
        } else {
          return {
            [`itunes:${ituneKey}`]: ituneVal
          }
        }
      })
      .filter(e => !!e)
  }

  const handleItems = items => {
    return items.map(item => {
      return {
        item: [
          ...handleItunes(item.itunes),
          ...Object.entries(item)
            .map(([key, value]) => {
              if (key === 'enclosure') {
                return {
                  _name: key,
                  _attrs: {
                    length: value.length,
                    type: value.type,
                    url: value.url
                  }
                }
              } else if (key !== 'itunes') {
                return { [key]: value }
              }
            })
            .filter(e => !!e)
        ]
      }
    })
  }

  let rv = []
  for (const [key, value] of Object.entries(json)) {
    if (key === 'itunes') {
      const fuck1 = handleItunes(value)
      rv = rv.concat(handleItunes(value))
    } else if (key === 'items') {
      const fuck2 = handleItems(value)
      rv = rv.concat(handleItems(value))
    } else {
      rv.push({ [key]: value })
    }
  }

  return rv
}

// update episode by episode guid
// add an new episode if the episode guid does not exist
/* const updateEpisode = async ({ podcastId, episodeId, data }) => {
  const currentTime = moment()
  const PUB_DATE_FORMAT = 'ddd, DD MMM YYYY HH:mm:ss ZZ'

  const rssS3Data = await S3.getObject({
    Bucket: S3_BUCKET,
    Key: `${podcastId}/index.rss`
  }).promise()

  let rssData = rssS3Data.Body.toString('utf-8')
  const parser = new RSSParser()
  let rssJson = await parser.parseString(rssData)

  let exist = false
  rssJson.items = rssJson.items.map(episode => {
    if (episode.guid === episodeId) {
      deepExtend(episode, data)
      exist = true
    }
    return episode
  })

  if (!exist) {
    // add new episode to the list
    rssJson.items.append({
      ...data,
      guid: episodeId,
      pubDate: currentTime.format(PUB_DATE_FORMAT)
    })
  }

  let rssCompatibleJson = toRSSCompatibleJSON(rssJson)

  // update lastBuildDate
  rssCompatibleJson.map(e => {
    if ('lastBuildDate' in e) {
      return {
        lastBuildDate: currentTime.format(PUB_DATE_FORMAT)
      }
    } else {
      return e
    }
  })
  const rssXML = await toXML(
    {
      _name: 'rss',
      _attrs: {
        version: '2.0',
        'xmlns:atom': 'http://www.w3.org/2005/Atom',
        'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
        'xmlns:googleplay': 'http://www.google.com/schemas/play-podcasts/1.0',
        'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd'
      },
      _content: {
        channel: [rssCompatibleJson]
      }
    },
    {
      header: true,
      indent: '  '
    }
  )

  await S3.putObject({
    Bucket: S3_BUCKET,
    Key: `${podcastId}/index.rss`,
    Body: Buffer.from(rssXML)
  }).promise()
} */

const getUploadUrl = async ({ podcastId, episodeId, type, fileType }) => {
  if (type === 'EPISODE') {
    // use existing episodeId for replacing audio file
    // else creat a new file
    let guid = episodeId || uuidv4()

    const s3Params = {
      Bucket: S3_BUCKET,
      Key: `${podcastId}/${guid}.mp4`,
      ContentType: 'video/mp4',
      ACL: 'public-read',
      // expires after 1h
      Expires: 3600
    }

    const uploadURL = await S3.getSignedUrlPromise('putObject', s3Params)
    return {
      uploadURL,
      guid
    }
  } else if (type === 'PODCAST_COVER') {
    let targetCoverId
    if (podcastId) {
      // update cover for the existing podcast
      // first retrieve existing cover url
      const podcastMeta = await getPodcastMeta({ podcastId })
      const url = podcastMeta.image.url
      // get uuid part
      const id = url.split('/').slice(-1)[0]
      if (id !== 'default_cover.png') {
        // custom cover
        // will be replaced
        targetCoverId = id
      }
    }

    if (!targetCoverId) {
      // upload a new cover with a new uuid
      targetCoverId = uuidv4()
    }

    const fileTypeSuffix = fileType.split('/').slice(-1)[0]
    const s3Params = {
      Bucket: S3_BUCKET,
      Key: `PODCAST_COVER/${targetCoverId}.${fileTypeSuffix}`,
      ContentType: 'image/*',
      ACL: 'public-read',
      // expires after 1h
      Expires: 3600
    }

    const uploadURL = await S3.getSignedUrlPromise('putObject', s3Params)
    return {
      uploadURL,
      guid: targetCoverId,
      url: `${BUCKET_BASE_URL}/PODCAST_COVER/${targetCoverId}.${fileTypeSuffix}`
    }
  } else if (type === 'EPISODE_COVER') {
    let targetCoverId
    if (podcastId) {
      // update cover for the existing podcast
      // first retrieve existing cover url
      const episode = await getEpisode({ episodeId })
      const url = episode.itunes.image
      // get uuid part
      const id = url.split('/').slice(-1)[0]
      if (id !== 'default_cover.png') {
        // custom cover
        // will be replaced
        targetCoverId = id
      }
    }

    if (!targetCoverId) {
      // upload a new cover with a new uuid
      targetCoverId = uuidv4()
    }

    const fileTypeSuffix = fileType.split('/').slice(-1)[0]
    const s3Params = {
      Bucket: S3_BUCKET,
      Key: `EPISODE_COVER/${targetCoverId}.${fileTypeSuffix}`,
      ContentType: 'image/*',
      ACL: 'public-read',
      // expires after 1h
      Expires: 3600
    }

    const uploadURL = await S3.getSignedUrlPromise('putObject', s3Params)
    return {
      uploadURL,
      guid: targetCoverId,
      url: `${BUCKET_BASE_URL}/EPISODE_COVER/${targetCoverId}.${fileTypeSuffix}`
    }
  }
}

function downloadFile(key) {
  return new Promise((resolve, reject) => {
    const destPath = `${TMP_PATH}/${path.basename(key)}`
    const params = {
      Bucket: S3_BUCKET,
      Key: key
    }
    const s3Stream = S3.getObject(params).createReadStream()
    const fileStream = fs.createWriteStream(destPath)
    s3Stream.on('error', reject)
    fileStream.on('error', reject)
    fileStream.on('close', () => {
      resolve(destPath)
    })
    s3Stream.pipe(fileStream)
  })
}

const getEpisode = async ({ episodeId }) => {
  const data = await dynamoDb
    .get({
      TableName: EPISODE_TABLE,
      Key: {
        episodeId
      }
    })
    .promise()
  return data.Item
}

const removeEpisode = async ({ podcastId, episodeId }) => {
  await dynamoDb
    .delete({
      TableName: EPISODE_TABLE,
      Key: {
        episodeId
      }
    })
    .promise()
}

const getPodcastMeta = async ({ podcastId }) => {
  const data = await dynamoDb
    .get({
      TableName: PODCAST_TABLE,
      Key: {
        podcastId
      }
    })
    .promise()
  return data.Item
}

const updatePodcastMeta = async ({ userId, podcastId, podcastMeta }) => {
  const currentTime = moment()
  const podcastMetaBase = {
    podcastId,
    feedUrl: `${BUCKET_BASE_URL}/${podcastId}/index.rss`,
    title: '',
    description: '',
    keywords: [],
    email: '',
    language: 'en-us',
    lastBuildDate: currentTime.format(PUB_DATE_FORMAT),
    pubDate: currentTime.format(PUB_DATE_FORMAT),
    author: '',
    email: '',
    image: {
      url: podcastMeta.image.url ? podcastMeta.image.url : `${BUCKET_BASE_URL}/default_cover.png`,
      title: '',
      link: `https://laterclub.com/podcast/${podcastId}`
    },
    userId,
    authorClubhouseId: '',
    authorClubhouseIdVerified: false
  }

  deepExtend(podcastMetaBase, podcastMeta)

  const {
    authorClubhouseId,
    authorClubhouseIdVerified,
    clubhouseIdVerificationCode
  } = podcastMetaBase
  if (!authorClubhouseIdVerified) {
    // not verified yet
    if (clubhouseIdVerificationCode) {
      // has verification code, now we try to verify user's
      // clubhouse username
      const { verificationStatus } = await verifyClubhouseId({
        clubhouseId: authorClubhouseId,
        code: clubhouseIdVerificationCode
      })

      if (!verificationStatus) {
        // we do not allow unverifed user to create/edit podcast settings
        throw new Error('Clubhouse username verification failed')
      }
      
      // update verification result
      podcastMetaBase.authorClubhouseIdVerified = verificationStatus
    }
  }

  // to avoid overwritting existing podcast with the same podcastId,
  // but different owner, we must check podcastId uniqueness first
  const existingPodcast = await getPodcastMeta({ podcastId })
  if (existingPodcast && existingPodcast.userId !== userId) {
    throw new Error(`PodcastId already exists`)
  }

  const data = await dynamoDb
    .put({
      TableName: PODCAST_TABLE,
      Item: {
        ...podcastMetaBase
      }
    })
    .promise()

  // refresh rss
  await refreshPodcastRss({ podcastId })
}

// auth op
const isOwner = async ({ userId, podcastId, episodeId }) => {
  console.log('isOwner:', userId, podcastId, episodeId)
  if (episodeId) {
    const episode = await getEpisode({ episodeId })
    if (episode.podcastId !== podcastId) {
      throw new Error('Auth error: episodeId does not match')
    }
  }
  const podcast = await getPodcastMeta({ podcastId })
  if (podcast && podcast.userId !== userId) {
    removeEpisode
    throw new Error('Auth error: user is not the owner of the podcast')
  }
  console.log('isOwner passed')
}

// add a new item or replace an old one
const addEpisodeToDb = async episode => {
  await dynamoDb
    .put({
      TableName: EPISODE_TABLE,
      Item: episode
    })
    .promise()
}

const getAudioMetadata = async ({ episodeId }) => {
  const episode = await getEpisode({ episodeId })
  return JSON.parse(episode.audioMetadata)
}

async function videoToAudio(videoPath, s3OutputPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .addInput(videoPath)
      .outputOptions(['-vn'])
      .save(`${TMP_PATH}/${path.basename(videoPath)}.mp3`)
      .on('error', err => {
        reject(err)
      })
      .on('end', async () => {
        const audioFile = fs.createReadStream(`${TMP_PATH}/${path.basename(videoPath)}.mp3`)
        const res = await S3.putObject({
          Bucket: S3_BUCKET,
          Key: s3OutputPath,
          Body: audioFile,
          ContentType: 'audio/mp3'
        }).promise()

        resolve(res)
      })
  })

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(`${TMP_PATH}/${path.basename(videoPath)}.mp3`, function (err, metadata) {
      if (err) {
        reject(err)
      } else {
        resolve(metadata)
      }
    })
  })
}

const getEpisodesByPodcastId = async ({ podcastId }) => {
  const params = {
    TableName: EPISODE_TABLE,
    IndexName: 'podcastId_index',
    KeyConditionExpression: 'podcastId = :podcastId',
    ExpressionAttributeValues: {
      ':podcastId': podcastId
    }
  }
  const data = await dynamoDb.query(params).promise()
  return data.Items
}

const refreshPodcastRss = async ({ podcastId }) => {
  const PUB_DATE_FORMAT = 'ddd, DD MMM YYYY HH:mm:ss ZZ'
  const currentTime = moment()

  // get podcast info
  const podcastMeta = await getPodcastMeta({ podcastId })

  // get all episodes of this podcast
  const episodes = await getEpisodesByPodcastId({ podcastId })

  const rssJson = {
    copyright: 'All rights reserved',
    title: podcastMeta.title,
    description: podcastMeta.description,
    feedUrl: `${BUCKET_BASE_URL}/${podcastId}/index.rss`,
    generator: 'https://laterclub.com',
    image: podcastMeta.image,
    itunes: {
      author: podcastMeta.author,
      categories: [],
      explicit: 'no',
      image: podcastMeta.image.url,
      keywords: [],
      owner: {
        name: podcastMeta.author,
        email: podcastMeta.email
      },
      summar: podcastMeta.description
    },
    language: 'en-us',
    pubDate: currentTime.format(PUB_DATE_FORMAT),
    lastBuildDate: currentTime.format(PUB_DATE_FORMAT),
    link: `https://laterclub.com/podcast/${podcastId}`,

    // episode items
    items: episodes
  }

  // create podcast channel level meta data
  const rssCompatibleJson = toRSSCompatibleJSON(rssJson)

  const rssXML = await toXML(
    {
      _name: 'rss',
      _attrs: {
        version: '2.0',
        'xmlns:atom': 'http://www.w3.org/2005/Atom',
        'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
        'xmlns:googleplay': 'http://www.google.com/schemas/play-podcasts/1.0',
        'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd'
      },
      _content: {
        channel: [rssCompatibleJson]
      }
    },
    {
      header: true,
      indent: '  '
    }
  )

  await S3.putObject({
    Bucket: S3_BUCKET,
    Key: `${podcastId}/index.rss`,
    Body: Buffer.from(rssXML)
  }).promise()
}

const convert = async ({ podcastId, episodeId }) => {
  const videoPath = await downloadFile(`${podcastId}/${episodeId}.mp4`)
  const audioMetadata = await videoToAudio(videoPath, `${podcastId}/${episodeId}.mp3`)
  return audioMetadata
}

const generateEpisodeDbItem = async ({ podcastId, episodeId, episodeMeta, audioMetadata }) => {
  // get podcast info
  const podcastMeta = await getPodcastMeta({ podcastId })

  const contentStripped = episodeMeta.content.replace(/(<([^>]+)>)/gi, '')
  return {
    // our custom attributes
    podcastId,
    episodeId,
    category: episodeMeta.category,
    topic: episodeMeta.topic,
    audioMetadata: JSON.stringify(audioMetadata),

    // rss attributes
    author: podcastMeta.author,
    creator: podcastMeta.author,
    title: episodeMeta.title,
    content: episodeMeta.content,
    'content:encoded': episodeMeta.content,
    'content:encodedSnippet': contentStripped,
    contentSnippet: contentStripped,
    guid: episodeId,
    link: `https://laterclub.com/podcast/${podcastId}/${episodeId}`,
    language: 'en-us',
    enclosure: {
      length: audioMetadata.format.size,
      type: 'audio/mpeg',
      url: `${BUCKET_BASE_URL}/${podcastId}/${episodeId}.mp3`
    },
    itunes: {
      author: podcastMeta.author,
      duration: Math.ceil(audioMetadata.format.duration),
      episode: episodeMeta.itunes.episode,
      explicit: 'no',
      image: episodeMeta.itunes.image,
      subtitle: contentStripped,
      summary: contentStripped
    },
    pubDate: episodeMeta.pubDate
  }
}

const updateEpisode = async ({ podcastId, episodeId, episodeMeta, convertAudio }) => {
  console.log(podcastId, episodeId, episodeMeta, convertAudio)
  var audioMetadata
  if (convertAudio) {
    // user uploaded a new video file
    // update the corresponding podcast audio file
    audioMetadata = await convert({ podcastId, episodeId })
  } else {
    audioMetadata = await getAudioMetadata({ episodeId })
  }

  // update episode given episodeId
  await addEpisodeToDb(
    await generateEpisodeDbItem({ podcastId, episodeId, episodeMeta, audioMetadata })
  )
  await refreshPodcastRss({ podcastId })
}

const addEpisode = async ({ podcastId, episodeId, episodeMeta }) => {
  // first convert video to audio
  const audioMetadata = await convert({ podcastId, episodeId })

  // add a new episode to db
  await addEpisodeToDb(
    await generateEpisodeDbItem({ podcastId, episodeId, episodeMeta, audioMetadata })
  )

  // update podcast rss
  await refreshPodcastRss({ podcastId })
}

const getPodcastsByUserId = async ({ userId }) => {
  const params = {
    TableName: PODCAST_TABLE,
    IndexName: 'userId_index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    }
  }
  const data = await dynamoDb.query(params).promise()
  return data.Items
}

const getUserData = async ({ userId }) => {
  // first retrive user's podcasts
  const podcasts = await getPodcastsByUserId({ userId })
  return { podcasts }
}

const verifyClubhouseId = async ({ clubhouseId, code }) => {
  const response = await got(`https://www.joinclubhouse.com/@${clubhouseId}`)
  console.log(response)
  const $ = cheerio.load(response.body)
  console.log($.root().html())
  return { verificationStatus: true }
}

export const main = async (event, context, callback) => {
  function handleResults(rv, err) {
    let response = {
      headers: {
        'Access-Control-Allow-Origin': '*', // Required for CORS support to work
        'Access-Control-Allow-Credentials': true // Required for cookies, authorization headers with HTTPS
      },
      isBase64Encoded: false,
      statusCode: 200,
      body: ''
    }

    if (!err) {
      response.statusCode = 200
      response.body = JSON.stringify(rv)
      callback(null, response)
    } else {
      console.log(err)
      response.statusCode = 500
      response.body = err.toString()
      callback(null, response)
    }
  }

  const request = JSON.parse(event.body)
  const { action, payload } = request
  const userId = event.requestContext.authorizer.Username
  const userAttributes = event.requestContext.authorizer.userAttributes

  try {
    let rv = {}
    console.log(payload)
    if (action === 'UPDATE_EPISODE') {
      isOwner({ userId, podcastId: payload.podcastId, episodeId: payload.episodeId })
      rv = await updateEpisode(payload)
    } else if (action === 'GET_UPLOAD_URL') {
      isOwner({ userId, podcastId: payload.podcastId })
      rv = await getUploadUrl(payload)
    } else if (action === 'ADD_EPISODE') {
      isOwner({ userId, podcastId: payload.podcastId })
      rv = await addEpisode(payload)
    } else if (action === 'GET_EPISODE') {
      rv = await getEpisode(payload)
    } else if (action === 'REMOVE_EPISODE') {
      isOwner({ userId, podcastId: payload.podcastId, episodeId: payload.episodeId })
      rv = await removeEpisode(payload)
    } else if (action === 'GET_EPISODES_BY_PODCAST_ID') {
      isOwner({ userId, podcastId: payload.podcastId })
      rv = await getEpisodesByPodcastId(payload)
    } else if (action === 'GET_PODCAST_META') {
      rv = await getPodcastMeta(payload)
    } else if (action === 'UPDATE_PODCAST_META') {
      isOwner({ userId, podcastId: payload.podcastId })
      rv = await updatePodcastMeta({ userId, ...payload })
    } else if (action === 'GET_USER_DATA') {
      rv = await getUserData({ userId })
    } else if (action === 'VERIFY_CLUBHOUSE_ID') {
      rv = await verifyClubhouseId(payload)
    }
    handleResults(rv)
  } catch (err) {
    handleResults(null, err)
  }
}
